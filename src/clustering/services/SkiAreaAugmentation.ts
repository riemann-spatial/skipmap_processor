import centroid from "@turf/centroid";
import { FeatureType, getRunDifficultyConvention, SourceType } from "openskidata-format";
import { GeocodingServerConfig, PostgresConfig, SnowCoverConfig } from "../../Config";
import { skiAreaStatistics } from "../../statistics/SkiAreaStatistics";
import Geocoder from "../../transforms/Geocoder";
import { sortPlaces, uniquePlaces } from "../../transforms/PlaceUtils";
import { isPlaceholderGeometry } from "../../utils/PlaceholderSiteGeometry";
import { ClusteringDatabase } from "../database/ClusteringDatabase";
import { performanceMonitor } from "../database/PerformanceMonitor";
import augmentGeoJSONFeatures from "../GeoJSONAugmenter";
import {
  LiftObject,
  MapObject,
  RunObject,
  SkiAreaObject,
} from "../MapObject";
import exportSkiAreasGeoJSON from "../SkiAreasExporter";

export class SkiAreaAugmentation {
  constructor(private database: ClusteringDatabase) {}

  async geocodeRunsAndLifts(
    geocoderConfig: GeocodingServerConfig | null,
    postgresConfig: PostgresConfig,
  ): Promise<void> {
    if (!geocoderConfig) {
      console.log("Skipping run/lift geocoding - no geocoder config provided");
      return;
    }

    const geocoder = new Geocoder(geocoderConfig, postgresConfig);
    await geocoder.initialize();

    try {
      await performanceMonitor.measure("Geocode all runs", async () => {
        const runsCursor = await this.database.getAllRuns(true);
        let runs: RunObject[] | null;
        while ((runs = await runsCursor.nextBatch())) {
          await this.geocodeObjects(runs, geocoder);
        }
      });

      await performanceMonitor.measure("Geocode all lifts", async () => {
        const liftsCursor = await this.database.getAllLifts(true);
        let lifts: LiftObject[] | null;
        while ((lifts = await liftsCursor.nextBatch())) {
          await this.geocodeObjects(lifts, geocoder);
        }
      });
    } finally {
      await geocoder.close();
    }
  }

  private async geocodeObjects(
    objects: (RunObject | LiftObject)[],
    geocoder: Geocoder,
  ): Promise<void> {
    await Promise.all(
      objects.map(async (object) => {
        try {
          const places = await geocoder.geocodeGeometry(object.geometry);
          await this.database.updateObject(object._key, {
            properties: {
              ...object.properties,
              places,
            },
          });
        } catch (error) {
          console.log(
            `Failed geocoding ${object.type} ${object._key}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }

  async augmentSkiAreasBasedOnAssignedLiftsAndRuns(
    geocoderConfig: GeocodingServerConfig | null,
    snowCoverConfig: SnowCoverConfig | null,
    postgresConfig: PostgresConfig,
  ): Promise<void> {
    let geocoder: Geocoder | null = null;

    if (geocoderConfig) {
      geocoder = new Geocoder(geocoderConfig, postgresConfig);
      await geocoder.initialize();
    }

    try {
      const skiAreasCursor = await this.database.getSkiAreas({
        useBatching: false,
      });

      const concurrentBatches = Math.min(3, require("os").cpus().length);
      const activeBatches = new Set<Promise<void>>();

      let skiAreas: SkiAreaObject[] | null;
      while ((skiAreas = await skiAreasCursor.nextBatch())) {
        const batchPromise = this.processBatchForAugmentation(
          skiAreas,
          geocoder,
          snowCoverConfig,
          postgresConfig,
        );
        activeBatches.add(batchPromise);

        batchPromise.finally(() => activeBatches.delete(batchPromise));

        if (activeBatches.size >= concurrentBatches) {
          await Promise.race(activeBatches);
        }
      }

      await Promise.all(activeBatches);
    } finally {
      if (geocoder) {
        await geocoder.close();
      }
    }
  }

  private async processBatchForAugmentation(
    skiAreas: SkiAreaObject[],
    geocoder: Geocoder | null,
    snowCoverConfig: SnowCoverConfig | null,
    postgresConfig: PostgresConfig,
  ): Promise<void> {
    return performanceMonitor.measure(
      "Augment batch of ski areas",
      async () => {
        await Promise.all(
          skiAreas.map(async (skiArea) => {
            const mapObjects = await this.database.getObjectsForSkiArea(
              skiArea.id,
            );
            await this.augmentSkiAreaBasedOnAssignedLiftsAndRuns(
              skiArea,
              mapObjects,
              geocoder,
              snowCoverConfig,
              postgresConfig,
            );
          }),
        );
      },
    );
  }

  private async augmentSkiAreaBasedOnAssignedLiftsAndRuns(
    skiArea: SkiAreaObject,
    memberObjects: MapObject[],
    geocoder: Geocoder | null,
    snowCoverConfig: SnowCoverConfig | null,
    postgresConfig: PostgresConfig,
  ): Promise<void> {
    const noSkimapOrgSource = !skiArea.properties.sources.some(
      (source) => source.type === SourceType.SKIMAP_ORG,
    );

    if (memberObjects.length === 0 && noSkimapOrgSource) {
      console.log(
        "Removing OpenStreetMap ski area without associated runs/lifts.",
      );
      await this.database.removeObject(skiArea._key);
      return;
    }

    const statistics = await skiAreaStatistics(
      memberObjects,
      postgresConfig,
      snowCoverConfig,
    );
    const updatedProperties = {
      ...skiArea.properties,
      statistics,
      runConvention: getRunDifficultyConvention(skiArea.geometry),
    };

    const memberPlaces = memberObjects.flatMap((obj) => obj.properties.places);

    if (memberPlaces.length > 0) {
      updatedProperties.places = sortPlaces(uniquePlaces(memberPlaces));
    } else if (geocoder) {
      const coordinates = centroid(skiArea.geometry).geometry.coordinates;
      try {
        const place = await geocoder.geocode(coordinates);
        if (place) {
          updatedProperties.places = [place];
        }
      } catch (error) {
        console.log(`Failed geocoding ${JSON.stringify(coordinates)}`);
        console.log(error);
      }
    }

    await this.database.updateObject(skiArea._key, {
      properties: updatedProperties,
    });
  }

  async removeSkiAreasWithoutGeometry(): Promise<void> {
    const cursor = await this.database.getSkiAreas({
      onlySource: SourceType.OPENSTREETMAP,
      useBatching: false,
    });

    let skiAreas: SkiAreaObject[] | null;

    while ((skiAreas = await cursor.nextBatch())) {
      await Promise.all(
        skiAreas.map(async (skiArea) => {
          if (
            skiArea.geometry.type === "Point" &&
            isPlaceholderGeometry(skiArea.geometry)
          ) {
            console.log(
              "Removing OpenStreetMap ski area as it doesn't have a geometry.",
            );
            await this.database.removeObject(skiArea._key);
          }
        }),
      );
    }
  }

  async augmentGeoJSONFeatures(
    inputPath: string,
    outputPath: string,
    featureType: FeatureType,
    snowCoverConfig: SnowCoverConfig | null,
    postgresConfig: PostgresConfig,
  ): Promise<void> {
    console.log(
      `Augmenting ${featureType} features from ${inputPath} to ${outputPath}`,
    );

    await augmentGeoJSONFeatures(
      inputPath,
      outputPath,
      this.database,
      featureType,
      snowCoverConfig,
      postgresConfig,
    );
  }

  async exportSkiAreasGeoJSON(outputPath: string): Promise<void> {
    console.log(`Exporting ski areas to ${outputPath}`);
    await exportSkiAreasGeoJSON(outputPath, this.database);
  }
}
