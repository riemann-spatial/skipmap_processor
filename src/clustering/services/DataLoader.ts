import { LiftFeature, RunFeature, SkiAreaFeature } from "openskidata-format";
import StreamToPromise from "stream-to-promise";
import { SnowCoverConfig } from "../../Config";
import { PostGISDataStore } from "../../io/PostGISDataStore";
import { mapAsync } from "../../transforms/StreamTransforms";
import { Logger } from "../../utils/Logger";
import { asyncGeneratorToStream } from "../../utils/StreamUtils";
import { VIIRSPixelExtractor } from "../../utils/VIIRSPixelExtractor";
import { ClusteringDatabase } from "../database/ClusteringDatabase";
import { performanceMonitor } from "../database/PerformanceMonitor";
import { DraftMapObject, MapObject } from "../MapObject";
import { prepareLift, prepareRun, prepareSkiArea } from "./FeaturePreparation";

type FeatureType = SkiAreaFeature | LiftFeature | RunFeature;

export class DataLoader {
  constructor(private database: ClusteringDatabase) {}

  async loadGraphData(
    dataStore: PostGISDataStore,
    snowCoverConfig: SnowCoverConfig | null,
  ): Promise<void> {
    const viirsExtractor = new VIIRSPixelExtractor();

    await performanceMonitor.withOperation("Loading Graph Data", async () => {
      await Promise.all(
        [
          this.loadFeatures(
            asyncGeneratorToStream(dataStore.streamProcessingSkiAreas()),
            (feature: SkiAreaFeature) => prepareSkiArea(feature),
          ),
          this.loadFeatures(
            asyncGeneratorToStream(dataStore.streamProcessingLifts()),
            (feature: LiftFeature) => prepareLift(feature),
          ),
          this.loadFeatures(
            asyncGeneratorToStream(dataStore.streamProcessingRuns()),
            (feature: RunFeature) =>
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
    stream: NodeJS.ReadableStream,
    prepare: (feature: T) => DraftMapObject,
  ): NodeJS.ReadableStream {
    return stream.pipe(
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
