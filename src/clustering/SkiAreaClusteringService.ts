import along from "@turf/along";
import centroid from "@turf/centroid";
import * as turf from "@turf/helpers";
import length from "@turf/length";
import nearestPoint from "@turf/nearest-point";
import * as GeoJSON from "geojson";
import {
  FeatureType,
  SkiAreaActivity,
  SkiAreaFeature,
  SourceType,
} from "openskidata-format";
import {
  GeocodingServerConfig,
  PostgresConfig,
  SnowCoverConfig,
} from "../Config";
import {
  HighwayFeature,
  HighwayProperties,
  SkiAreaReference,
} from "../features/HighwayFeature";
import { PostGISDataStore } from "../io/PostGISDataStore";
import { toOutputTable } from "../transforms/ProcessingTableWriter";
import { getPoints, getPositions } from "../transforms/GeoTransforms";
import { Logger } from "../utils/Logger";
import { asyncGeneratorToStream } from "../utils/StreamUtils";
import { ClusteringDatabase } from "./database/ClusteringDatabase";
import { performanceMonitor } from "./database/PerformanceMonitor";
import { MapObject } from "./MapObject";
import {
  DataLoader,
  GeneratedSkiAreas,
  SkiAreaAssignment,
  SkiAreaAugmentation,
  SkiAreaMerging,
} from "./services";
import streamToPromise from "stream-to-promise";
import { mapAsync } from "../transforms/StreamTransforms";

export const allSkiAreaActivities = new Set([
  SkiAreaActivity.Downhill,
  SkiAreaActivity.Nordic,
]);

export class SkiAreaClusteringService {
  private dataLoader: DataLoader;
  private assignment: SkiAreaAssignment;
  private merging: SkiAreaMerging;
  private generatedSkiAreas: GeneratedSkiAreas;
  private augmentation: SkiAreaAugmentation;

  constructor(private database: ClusteringDatabase) {
    this.dataLoader = new DataLoader(database);
    this.assignment = new SkiAreaAssignment(database);
    this.merging = new SkiAreaMerging(database);
    this.generatedSkiAreas = new GeneratedSkiAreas(database);
    this.augmentation = new SkiAreaAugmentation(database);
  }

  async clusterSkiAreas(
    dataStore: PostGISDataStore,
    geocoderConfig: GeocodingServerConfig | null,
    snowCoverConfig: SnowCoverConfig | null,
    postgresConfig: PostgresConfig,
  ): Promise<void> {
    await performanceMonitor.withOperation(
      "Loading graph into database",
      async () => {
        await this.dataLoader.loadGraphData(dataStore, snowCoverConfig);
      },
    );

    await this.performClustering(
      geocoderConfig,
      snowCoverConfig,
      postgresConfig,
    );

    // Reset output tables before writing clustered results
    await dataStore.resetOutputTables();

    await performanceMonitor.withOperation("Augmenting Runs", async () => {
      await this.augmentation.augmentFeatures(
        dataStore,
        FeatureType.Run,
        snowCoverConfig,
        postgresConfig,
      );
    });

    await performanceMonitor.withOperation("Augmenting Lifts", async () => {
      await this.augmentation.augmentFeatures(
        dataStore,
        FeatureType.Lift,
        null,
        postgresConfig,
      );
    });

    await performanceMonitor.withOperation("Exporting Ski Areas", async () => {
      await this.augmentation.exportSkiAreas(dataStore);
    });
  }

  private async performClustering(
    geocoderConfig: GeocodingServerConfig | null,
    snowCoverConfig: SnowCoverConfig | null,
    postgresConfig: PostgresConfig,
  ): Promise<void> {
    await performanceMonitor.withOperation(
      "Assign ski area activities and geometry based on member objects",
      async () => {
        await this.assignment.assignSkiAreaActivitiesAndGeometryBasedOnMemberObjects(
          this.skiAreaGeometry,
        );
      },
    );

    await performanceMonitor.withOperation(
      "Remove ambiguous duplicate ski areas",
      async () => {
        await this.assignment.removeAmbiguousDuplicateSkiAreas();
      },
    );

    await performanceMonitor.withOperation(
      "Assign objects in OSM polygon ski areas",
      async () => {
        const keepLanduseWithSiteOverlap =
          process.env.KEEP_LANDUSE_WITH_SITE_OVERLAP === "1";
        await this.assignment.assignObjectsToSkiAreas({
          skiArea: {
            onlySource: SourceType.OPENSTREETMAP,
            removeIfNoObjectsFound: true,
            removeIfSubstantialNumberOfObjectsInSkiAreaSite:
              !keepLanduseWithSiteOverlap,
          },
          objects: { onlyInPolygon: true },
        });
      },
    );

    await performanceMonitor.withOperation(
      "Assign nearby objects to OSM ski areas",
      async () => {
        await this.assignment.assignObjectsToSkiAreas({
          skiArea: { onlySource: SourceType.OPENSTREETMAP },
          objects: { onlyIfNotAlreadyAssigned: true },
        });
      },
    );

    await performanceMonitor.withOperation(
      "Merge skimap.org and OpenStreetMap ski areas",
      async () => {
        await this.merging.mergeSkimapOrgWithOpenStreetMapSkiAreas();
      },
    );

    await performanceMonitor.withOperation(
      "Assign nearby objects to Skimap.org ski areas",
      async () => {
        await this.assignment.assignObjectsToSkiAreas({
          skiArea: { onlySource: SourceType.SKIMAP_ORG },
          objects: { onlyIfNotAlreadyAssigned: true },
        });
      },
    );

    await performanceMonitor.withOperation(
      "Generate ski areas for unassigned objects",
      async () => {
        await this.generatedSkiAreas.generateSkiAreasForUnassignedObjects(
          this.skiAreaGeometry,
        );
      },
    );

    await performanceMonitor.withOperation(
      "Geocode runs and lifts",
      async () => {
        await this.augmentation.geocodeRunsAndLifts(
          geocoderConfig,
          postgresConfig,
        );
      },
    );

    await performanceMonitor.withOperation(
      "Augment ski areas based on assigned lifts and runs",
      async () => {
        await this.augmentation.augmentSkiAreasBasedOnAssignedLiftsAndRuns(
          geocoderConfig,
          snowCoverConfig,
          postgresConfig,
        );
      },
    );

    await performanceMonitor.withOperation(
      "Remove ski areas without a geometry",
      async () => {
        await this.augmentation.removeSkiAreasWithoutGeometry();
      },
    );
  }

  private skiAreaGeometry = (memberObjects: MapObject[]): GeoJSON.Point => {
    if (memberObjects.length === 0) {
      throw new Error("No member objects to compute geometry from");
    }

    const centroidPoint = centroid({
      type: "GeometryCollection",
      geometries: memberObjects.map((object) => object.geometry),
    }).geometry;

    const nearestPointToCentroid = nearestPoint(
      centroidPoint,
      getPoints(
        memberObjects.flatMap((object) => getPositions(object.geometry)),
      ),
    ).geometry;

    const line = turf.lineString([
      nearestPointToCentroid.coordinates,
      centroidPoint.coordinates,
    ]);

    if (length(line) > 0.1) {
      return along(line, 0.1).geometry;
    } else {
      return centroidPoint;
    }
  };

  /**
   * Associate highways with ski areas and remove orphaned highways.
   *
   * Highways are kept or discarded based on a dissolved buffer around
   * all surviving ski features (runs, lifts, ski areas) computed in PostGIS.
   * Highways outside this buffer are removed.
   *
   * Ski area references on kept highways are computed via a PostGIS
   * spatial join (ST_Intersects) against ski area polygons.
   */
  async associateHighwaysWithSkiAreas(
    dataStore: PostGISDataStore,
    bufferMeters: number,
  ): Promise<void> {
    await performanceMonitor.withOperation(
      "Associating highways with ski areas",
      async () => {
        // Read highways from processing tables into flat array
        const highways: Array<{
          id: string;
          featureJson: string;
          geometryJson: string;
        }> = [];
        for await (const feature of dataStore.streamProcessingHighways()) {
          const props = feature.properties as HighwayProperties;
          highways.push({
            id: props.id,
            featureJson: JSON.stringify(feature),
            geometryJson: JSON.stringify(feature.geometry),
          });
        }
        Logger.log(`Read ${highways.length} highways from processing table`);

        if (highways.length === 0) {
          Logger.log("No highways to process");
          return;
        }

        // Read ski area polygons from output tables
        const skiAreaPolygons: Array<{
          id: string;
          name: string | null;
          geometryJson: string;
        }> = [];
        for await (const feature of dataStore.streamOutputSkiAreas()) {
          const skiArea = feature as SkiAreaFeature;
          if (
            skiArea.geometry.type === "Polygon" ||
            skiArea.geometry.type === "MultiPolygon"
          ) {
            skiAreaPolygons.push({
              id: skiArea.properties.id,
              name: skiArea.properties.name,
              geometryJson: JSON.stringify(skiArea.geometry),
            });
          }
        }
        Logger.log(
          `Loaded ${skiAreaPolygons.length} ski area polygons for reference assignment`,
        );

        try {
          // Load into PostGIS temp tables and filter by buffer
          const { keptCount, droppedCount } =
            await this.database.prepareHighwayAssociation(
              highways,
              skiAreaPolygons,
              bufferMeters,
            );

          // Stream results from PostGIS spatial join and write to output table
          const outputFeatures: GeoJSON.Feature[] = [];
          let writtenCount = 0;

          for await (const result of this.database.streamHighwaySkiAreaAssociations()) {
            const feature = JSON.parse(result.featureJson) as HighwayFeature;
            const matchingSkiAreas: SkiAreaReference[] =
              result.matchingSkiAreas.map((sa) => ({
                properties: { id: sa.id, name: sa.name },
              }));

            const outputFeature = {
              ...feature,
              properties: {
                ...feature.properties,
                skiAreas: matchingSkiAreas,
              },
            };

            outputFeatures.push(outputFeature as GeoJSON.Feature);
            writtenCount++;

            // Batch write to output table
            if (outputFeatures.length >= 500) {
              await dataStore.saveOutputHighways(
                outputFeatures.map((f) => ({
                  feature_id:
                    (f.properties as HighwayProperties).id ||
                    String(f.id) ||
                    `unknown-${Date.now()}`,
                  geometry: f.geometry,
                  properties: f.properties as Record<string, unknown>,
                })),
              );
              outputFeatures.length = 0;
            }
          }

          // Write remaining features
          if (outputFeatures.length > 0) {
            await dataStore.saveOutputHighways(
              outputFeatures.map((f) => ({
                feature_id:
                  (f.properties as HighwayProperties).id ||
                  String(f.id) ||
                  `unknown-${Date.now()}`,
                geometry: f.geometry,
                properties: f.properties as Record<string, unknown>,
              })),
            );
          }

          Logger.log(
            `Finished associating highways with ski areas: kept ${keptCount}, removed ${droppedCount} orphaned, wrote ${writtenCount}`,
          );
        } finally {
          await this.database.cleanupHighwayAssociation();
        }
      },
    );
  }
}
