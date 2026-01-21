import { AssertionError } from "assert";
import * as GeoJSON from "geojson";
import { SkiAreaActivity, SourceType } from "openskidata-format";
import {
  ClusteringDatabase,
  SearchContext,
} from "../database/ClusteringDatabase";
import { performanceMonitor } from "../database/PerformanceMonitor";
import {
  LiftObject,
  MapObject,
  MapObjectType,
  RunObject,
  SkiAreaObject,
} from "../MapObject";
import { allSkiAreaActivities } from "../SkiAreaClusteringService";

const maxDistanceInKilometers = 0.5;

export interface AssignObjectsOptions {
  skiArea: {
    onlySource: SourceType;
    removeIfNoObjectsFound?: boolean;
    removeIfSubstantialNumberOfObjectsInSkiAreaSite?: boolean;
  };
  objects: { onlyIfNotAlreadyAssigned?: boolean; onlyInPolygon?: boolean };
}

export class SkiAreaAssignment {
  constructor(private database: ClusteringDatabase) {}

  async assignSkiAreaActivitiesAndGeometryBasedOnMemberObjects(
    skiAreaGeometryFn: (memberObjects: MapObject[]) => GeoJSON.Point,
  ): Promise<void> {
    const skiAreasCursor = await this.database.getSkiAreas({
      useBatching: true,
    });

    const concurrentBatches = Math.min(4, require("os").cpus().length);
    const activeBatches = new Set<Promise<void>>();

    let skiAreas: SkiAreaObject[] | null;
    while ((skiAreas = await skiAreasCursor.nextBatch())) {
      const batchPromise = this.processBatchForActivitiesAndGeometry(
        skiAreas,
        skiAreaGeometryFn,
      );
      activeBatches.add(batchPromise);

      batchPromise.finally(() => activeBatches.delete(batchPromise));

      if (activeBatches.size >= concurrentBatches) {
        await Promise.race(activeBatches);
      }
    }

    await Promise.all(activeBatches);
  }

  private async processBatchForActivitiesAndGeometry(
    skiAreas: SkiAreaObject[],
    skiAreaGeometryFn: (memberObjects: MapObject[]) => GeoJSON.Point,
  ): Promise<void> {
    return performanceMonitor.measure(
      "Batch assign ski area activities and geometry based on member objects",
      async () => {
        await Promise.all(
          skiAreas.map(async (skiArea) => {
            if (skiArea.activities.length > 0) {
              return;
            }

            const memberObjects = await this.database.getObjectsForSkiArea(
              skiArea.id,
            );
            const activities = getActivitiesBasedOnRunsAndLifts(memberObjects);

            if (memberObjects.length === 0) {
              return;
            }

            await this.database.updateObject(skiArea._key, {
              activities: [...activities],
              geometry: skiAreaGeometryFn(memberObjects),
              isPolygon: false,
              properties: {
                ...skiArea.properties,
                activities: [...activities],
              },
            });
          }),
        );
      },
    );
  }

  async removeAmbiguousDuplicateSkiAreas(): Promise<void> {
    const cursor = await this.database.getSkiAreas({
      onlyPolygons: true,
      onlySource: SourceType.OPENSTREETMAP,
      useBatching: false,
    });

    const concurrentBatches = Math.min(3, require("os").cpus().length);
    const activeBatches = new Set<Promise<void>>();

    let skiAreas: SkiAreaObject[] | null;
    while ((skiAreas = await cursor.nextBatch())) {
      const batchPromise = this.processBatchForDuplicateRemoval(skiAreas);
      activeBatches.add(batchPromise);

      batchPromise.finally(() => activeBatches.delete(batchPromise));

      if (activeBatches.size >= concurrentBatches) {
        await Promise.race(activeBatches);
      }
    }

    await Promise.all(activeBatches);
  }

  private async processBatchForDuplicateRemoval(
    skiAreas: SkiAreaObject[],
  ): Promise<void> {
    await Promise.all(
      skiAreas.map(async (skiArea) => {
        if (
          skiArea.geometry.type !== "Polygon" &&
          skiArea.geometry.type !== "MultiPolygon"
        ) {
          throw new AssertionError({
            message:
              "getSkiAreas query should have only returned ski areas with a Polygon geometry.",
          });
        }

        const otherSkiAreasCursor = await this.database.getSkiAreas({
          onlySource: SourceType.SKIMAP_ORG,
          onlyInPolygon: skiArea.geometry,
          useBatching: false,
        });

        const otherSkiAreas = await otherSkiAreasCursor.all();
        if (otherSkiAreas.length > 1) {
          console.log(
            "Removing OpenStreetMap ski area as it contains multiple Skimap.org ski areas and can't be merged correctly.",
          );
          console.log(JSON.stringify(skiArea));

          await this.database.removeObject(skiArea._key);
        }
      }),
    );
  }

  async assignObjectsToSkiAreas(options: AssignObjectsOptions): Promise<void> {
    const skiAreasCursor = await this.database.getSkiAreas({
      onlyPolygons: options.objects.onlyInPolygon || false,
      onlySource: options.skiArea.onlySource,
      useBatching: false,
    });

    const skiAreas = await skiAreasCursor.all();

    if (options.objects.onlyIfNotAlreadyAssigned) {
      for (const skiArea of skiAreas) {
        const memberObjects = await this.processSkiAreaForObjectAssignment(
          skiArea,
          options,
        );

        if (memberObjects === null) {
          continue;
        }

        await this.database.markObjectsAsPartOfSkiArea(
          skiArea.id,
          memberObjects.map((obj) => obj._key),
          options.objects.onlyInPolygon || false,
        );

        const hasKnownSkiAreaActivities = skiArea.activities.length > 0;
        if (!hasKnownSkiAreaActivities) {
          const activities = getActivitiesBasedOnRunsAndLifts(memberObjects);
          await this.database.updateObject(skiArea._key, {
            activities: [...activities],
            properties: {
              ...skiArea.properties,
              activities: [...activities],
            },
          });
        }
      }
    } else {
      const chunkSize = 3;
      for (let i = 0; i < skiAreas.length; i += chunkSize) {
        const chunk = skiAreas.slice(i, i + chunkSize);

        await Promise.all(
          chunk.map(async (skiArea) => {
            const memberObjects = await this.processSkiAreaForObjectAssignment(
              skiArea,
              options,
            );

            if (memberObjects === null) {
              return;
            }

            await this.database.markObjectsAsPartOfSkiArea(
              skiArea.id,
              memberObjects.map((obj) => obj._key),
              options.objects.onlyInPolygon || false,
            );

            const hasKnownSkiAreaActivities = skiArea.activities.length > 0;
            if (!hasKnownSkiAreaActivities) {
              const activities =
                getActivitiesBasedOnRunsAndLifts(memberObjects);
              await this.database.updateObject(skiArea._key, {
                activities: [...activities],
                properties: {
                  ...skiArea.properties,
                  activities: [...activities],
                },
              });
            }
          }),
        );
      }
    }
  }

  private async processSkiAreaForObjectAssignment(
    skiArea: SkiAreaObject,
    options: AssignObjectsOptions,
  ): Promise<MapObject[] | null> {
    const id = skiArea.properties.id;
    const hasKnownSkiAreaActivities = skiArea.activities.length > 0;
    const activitiesForClustering = hasKnownSkiAreaActivities
      ? skiArea.activities
      : Array.from(allSkiAreaActivities);

    let searchContext: SearchContext;

    if (options.objects.onlyInPolygon) {
      if (
        skiArea.geometry.type === "Polygon" ||
        skiArea.geometry.type === "MultiPolygon"
      ) {
        searchContext = {
          id,
          activities: activitiesForClustering,
          searchType: "contains",
          searchPolygon: skiArea.geometry,
          isFixedSearchArea: true,
          alreadyVisited: [skiArea._key],
          excludeObjectsAlreadyInSkiArea:
            options.objects.onlyIfNotAlreadyAssigned || false,
        };
      } else {
        throw new AssertionError({
          message: "Ski area geometry must be a polygon.",
        });
      }
    } else {
      searchContext = {
        id,
        activities: activitiesForClustering,
        searchType: "intersects",
        isFixedSearchArea: false,
        alreadyVisited: [skiArea._key],
        excludeObjectsAlreadyInSkiArea:
          options.objects.onlyIfNotAlreadyAssigned || false,
      };
    }

    const memberObjects = await this.visitObject(searchContext, skiArea);

    const removeDueToNoObjects =
      options.skiArea.removeIfNoObjectsFound &&
      !memberObjects.some((object) => object.type !== MapObjectType.SkiArea);

    if (removeDueToNoObjects) {
      console.log(
        `Removing ski area (${JSON.stringify(
          skiArea.properties.sources,
        )}) as no objects were found.`,
      );
      await this.database.removeObject(skiArea._key);
      return null;
    }

    const liftsAndRuns = memberObjects.filter(
      (object): object is LiftObject | RunObject =>
        object.type === MapObjectType.Lift || object.type === MapObjectType.Run,
    );
    const liftsAndRunsInSiteRelation = liftsAndRuns.filter(
      (object) => object.isInSkiAreaSite,
    );

    const removeDueToSignificantObjectsInSiteRelation =
      options.skiArea.removeIfSubstantialNumberOfObjectsInSkiAreaSite &&
      liftsAndRunsInSiteRelation.length / liftsAndRuns.length > 0.5;

    if (removeDueToSignificantObjectsInSiteRelation) {
      console.log(
        `Removing ski area (${JSON.stringify(
          skiArea.properties.sources,
        )}) as a substantial number of objects were in a site=piste relation (${
          liftsAndRunsInSiteRelation.length
        } / ${liftsAndRuns.length}).`,
      );
      await this.database.removeObject(skiArea._key);
      return null;
    }

    return memberObjects;
  }

  async visitObject(
    context: SearchContext,
    object: MapObject,
  ): Promise<MapObject[]> {
    let foundObjects: MapObject[] = [object];

    const filteredActivities = context.activities.filter((activity) =>
      object.activities.includes(activity),
    );

    const objectContext: SearchContext = {
      ...context,
      searchPolygon: context.isFixedSearchArea ? context.searchPolygon : null,
      activities:
        filteredActivities.length > 0 ? filteredActivities : context.activities,
    };

    if (context.searchPolygon) {
      const searchArea = context.searchPolygon;
      return foundObjects.concat(
        await this.visitPolygonGeometry(objectContext, searchArea),
      );
    } else {
      const bufferedContext: SearchContext = {
        ...objectContext,
        bufferDistanceKm: maxDistanceInKilometers,
      };

      let geometryForSearch: GeoJSON.Geometry = object.geometry;

      if (object.type === MapObjectType.SkiArea) {
        geometryForSearch = await this.database.getObjectDerivedSkiAreaGeometry(
          object.id,
        );
      }

      const nearbyObjects = await this.database.findNearbyObjects(
        geometryForSearch,
        bufferedContext,
      );
      return foundObjects.concat(
        await this.processFoundObjects(objectContext, nearbyObjects),
      );
    }
  }

  private async visitPolygonGeometry(
    context: SearchContext,
    searchArea: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  ): Promise<MapObject[]> {
    const objects = await this.database.findNearbyObjects(searchArea, context);
    return await this.processFoundObjects(context, objects);
  }

  private async processFoundObjects(
    context: SearchContext,
    objects: MapObject[],
  ): Promise<MapObject[]> {
    if (context.isFixedSearchArea) {
      return objects;
    } else {
      let foundObjects: MapObject[] = [];
      for (let i = 0; i < objects.length; i++) {
        foundObjects = foundObjects.concat(
          await this.visitObject(context, objects[i]),
        );
      }
      return foundObjects;
    }
  }
}

export function getActivitiesBasedOnRunsAndLifts(
  mapObjects: MapObject[],
): SkiAreaActivity[] {
  return Array.from(
    mapObjects
      .filter((object) => object.type !== MapObjectType.SkiArea)
      .reduce((accumulatedActivities, object) => {
        object.activities.forEach((activity) => {
          if (allSkiAreaActivities.has(activity)) {
            accumulatedActivities.add(activity);
          }
        });
        return accumulatedActivities;
      }, new Set<SkiAreaActivity>()),
  );
}
