import along from "@turf/along";
import centroid from "@turf/centroid";
import * as turf from "@turf/helpers";
import length from "@turf/length";
import nearestPoint from "@turf/nearest-point";
import * as GeoJSON from "geojson";
import { FeatureType, SkiAreaActivity, SourceType } from "openskidata-format";
import {
  GeocodingServerConfig,
  PostgresConfig,
  SnowCoverConfig,
} from "../Config";
import { getPoints, getPositions } from "../transforms/GeoTransforms";
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
    skiAreasPath: string,
    liftsPath: string,
    runsPath: string,
    outputSkiAreasPath: string,
    outputLiftsPath: string,
    outputRunsPath: string,
    geocoderConfig: GeocodingServerConfig | null,
    snowCoverConfig: SnowCoverConfig | null,
    postgresConfig: PostgresConfig,
  ): Promise<void> {
    await performanceMonitor.withOperation(
      "Loading graph into database",
      async () => {
        await this.dataLoader.loadGraphData(
          skiAreasPath,
          liftsPath,
          runsPath,
          snowCoverConfig,
        );
      },
    );

    await this.performClustering(
      geocoderConfig,
      snowCoverConfig,
      postgresConfig,
    );

    await performanceMonitor.withOperation("Augmenting Runs", async () => {
      await this.augmentation.augmentGeoJSONFeatures(
        runsPath,
        outputRunsPath,
        FeatureType.Run,
        snowCoverConfig,
        postgresConfig,
      );
    });

    await performanceMonitor.withOperation("Augmenting Lifts", async () => {
      await this.augmentation.augmentGeoJSONFeatures(
        liftsPath,
        outputLiftsPath,
        FeatureType.Lift,
        null,
        postgresConfig,
      );
    });

    await performanceMonitor.withOperation("Exporting Ski Areas", async () => {
      await this.augmentation.exportSkiAreasGeoJSON(outputSkiAreasPath);
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
        await this.assignment.assignObjectsToSkiAreas({
          skiArea: {
            onlySource: SourceType.OPENSTREETMAP,
            removeIfNoObjectsFound: true,
            removeIfSubstantialNumberOfObjectsInSkiAreaSite: true,
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
        await this.augmentation.geocodeRunsAndLifts(geocoderConfig, postgresConfig);
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
}
