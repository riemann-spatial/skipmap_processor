import { LiftFeature, RunFeature, SkiAreaFeature } from "openskidata-format";
import StreamToPromise from "stream-to-promise";
import { SnowCoverConfig } from "../../Config";
import { readGeoJSONFeatures } from "../../io/GeoJSONReader";
import { mapAsync } from "../../transforms/StreamTransforms";
import { Logger } from "../../utils/Logger";
import { VIIRSPixelExtractor } from "../../utils/VIIRSPixelExtractor";
import { ClusteringDatabase } from "../database/ClusteringDatabase";
import { performanceMonitor } from "../database/PerformanceMonitor";
import { DraftMapObject, MapObject } from "../MapObject";
import { prepareLift, prepareRun, prepareSkiArea } from "./FeaturePreparation";

type FeatureType = SkiAreaFeature | LiftFeature | RunFeature;

export class DataLoader {
  constructor(private database: ClusteringDatabase) {}

  async loadGraphData(
    skiAreasPath: string,
    liftsPath: string,
    runsPath: string,
    snowCoverConfig: SnowCoverConfig | null,
  ): Promise<void> {
    const viirsExtractor = new VIIRSPixelExtractor();

    await performanceMonitor.withOperation("Loading Graph Data", async () => {
      await Promise.all(
        [
          this.loadFeatures(skiAreasPath, (feature: SkiAreaFeature) =>
            prepareSkiArea(feature),
          ),
          this.loadFeatures(liftsPath, (feature: LiftFeature) =>
            prepareLift(feature),
          ),
          this.loadFeatures(runsPath, (feature: RunFeature) =>
            prepareRun(feature, viirsExtractor, snowCoverConfig),
          ),
        ].map<Promise<Buffer>>(StreamToPromise),
      );
    });

    await performanceMonitor.withOperation("Creating indexes", async () => {
      await this.database.createIndexes();
    });
  }

  private loadFeatures<T extends FeatureType>(
    path: string,
    prepare: (feature: T) => DraftMapObject,
  ): NodeJS.ReadableStream {
    return readGeoJSONFeatures(path).pipe(
      mapAsync(async (feature: unknown) => {
        try {
          const preparedObject = prepare(feature as T) as MapObject;
          await this.database.saveObject(preparedObject);
        } catch (e) {
          Logger.error(
            "Failed loading feature " + JSON.stringify(feature),
            e instanceof Error ? e.message : String(e),
          );
        }
      }, 10),
    );
  }
}
