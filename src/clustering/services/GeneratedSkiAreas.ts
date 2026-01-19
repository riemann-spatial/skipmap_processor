import * as GeoJSON from "geojson";
import {
  FeatureType,
  getRunDifficultyConvention,
  SkiAreaActivity,
  SourceType,
  Status,
} from "openskidata-format";
import { v4 as uuid } from "uuid";
import {
  ClusteringDatabase,
  SearchContext,
} from "../database/ClusteringDatabase";
import {
  DraftSkiArea,
  MapObject,
  MapObjectType,
  RunObject,
} from "../MapObject";
import { allSkiAreaActivities } from "../SkiAreaClusteringService";
import { SkiAreaAssignment } from "./SkiAreaAssignment";

export class GeneratedSkiAreas {
  private lastProcessedRunKey: string | null = null;
  private assignment: SkiAreaAssignment;

  constructor(private database: ClusteringDatabase) {
    this.assignment = new SkiAreaAssignment(database);
  }

  async generateSkiAreasForUnassignedObjects(
    skiAreaGeometryFn: (memberObjects: MapObject[]) => GeoJSON.Point,
  ): Promise<void> {
    let unassignedRun: MapObject | null;
    while ((unassignedRun = await this.database.getNextUnassignedRun())) {
      if (this.lastProcessedRunKey === unassignedRun._key) {
        console.log(
          `WARNING: Run ${unassignedRun._key} selected again - marking as processed to prevent infinite loop`,
        );
        try {
          await this.database.updateObject(unassignedRun._key, {
            isBasisForNewSkiArea: false,
          });
        } catch (updateException) {
          console.log(
            "Failed to mark repeated run as processed:",
            updateException,
          );
        }
        continue;
      }

      this.lastProcessedRunKey = unassignedRun._key;

      try {
        await this.generateSkiAreaForRun(
          unassignedRun as RunObject,
          skiAreaGeometryFn,
        );
      } catch (exception) {
        console.log("Processing unassigned run failed.", exception);
        try {
          await this.database.updateObject(unassignedRun._key, {
            isBasisForNewSkiArea: false,
          });
        } catch (updateException) {
          console.log(
            "Failed to mark run as processed after error:",
            updateException,
          );
        }
      }
    }
  }

  private async generateSkiAreaForRun(
    unassignedRun: RunObject,
    skiAreaGeometryFn: (memberObjects: MapObject[]) => GeoJSON.Point,
  ): Promise<void> {
    const newSkiAreaID = uuid();
    let activities = unassignedRun.activities.filter((activity) =>
      allSkiAreaActivities.has(activity),
    );

    const context: SearchContext = {
      id: newSkiAreaID,
      activities,
      alreadyVisited: [unassignedRun._key],
      searchType: "intersects",
      isFixedSearchArea: false,
    };

    let memberObjects = await this.assignment.visitObject(context, unassignedRun);

    if (
      activities.includes(SkiAreaActivity.Downhill) &&
      !memberObjects.some((object) => object.type === MapObjectType.Lift)
    ) {
      activities = activities.filter(
        (activity) => activity !== SkiAreaActivity.Downhill,
      );
      memberObjects = memberObjects.filter((object) => {
        const hasAnotherSkiAreaActivity = object.activities.some(
          (activity) =>
            activity !== SkiAreaActivity.Downhill &&
            allSkiAreaActivities.has(activity),
        );
        return hasAnotherSkiAreaActivity;
      });
    }

    if (activities.length === 0 || memberObjects.length === 0) {
      await this.database.updateObject(unassignedRun._key, {
        isBasisForNewSkiArea: false,
      });
      return;
    }

    await this.createGeneratedSkiArea(
      newSkiAreaID,
      activities,
      memberObjects,
      skiAreaGeometryFn,
    );
  }

  private async createGeneratedSkiArea(
    id: string,
    activities: SkiAreaActivity[],
    memberObjects: MapObject[],
    skiAreaGeometryFn: (memberObjects: MapObject[]) => GeoJSON.Point,
  ): Promise<void> {
    const geometry = skiAreaGeometryFn(memberObjects);

    const draftSkiArea: DraftSkiArea = {
      _key: id,
      id: id,
      type: MapObjectType.SkiArea,
      skiAreas: [id],
      activities: activities,
      geometry: geometry,
      isPolygon: false,
      source: SourceType.OPENSTREETMAP,
      properties: {
        type: FeatureType.SkiArea,
        id: id,
        name: null,
        activities: activities,
        status: Status.Operating,
        sources: [],
        runConvention: getRunDifficultyConvention(geometry),
        websites: [],
        wikidataID: null,
        places: [],
      },
    };

    try {
      await this.database.saveObject(draftSkiArea as MapObject);
    } catch (exception) {
      console.log("Failed saving ski area", exception);
      throw exception;
    }

    await this.database.markObjectsAsPartOfSkiArea(
      id,
      memberObjects.map((obj) => obj._key),
      false,
    );
  }
}
