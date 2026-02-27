import { Writable } from "stream";
import { PostGISDataStore, ProcessingFeature } from "../io/PostGISDataStore";
import { OutputFeature } from "../io/PostGISDataStore";
import { Logger } from "../utils/Logger";

type ProcessingTableType =
  | "ski_areas"
  | "runs"
  | "lifts"
  | "highways"
  | "peaks";

function geoJSONFeatureToProcessingFeature(
  feature: GeoJSON.Feature,
): ProcessingFeature {
  const props = feature.properties || {};
  return {
    feature_id: props.id || String(feature.id) || `unknown-${Date.now()}`,
    geometry: feature.geometry,
    properties: props,
  };
}

function geoJSONFeatureToOutputFeature(
  feature: GeoJSON.Feature,
): OutputFeature {
  const props = feature.properties || {};
  return {
    feature_id: props.id || String(feature.id) || `unknown-${Date.now()}`,
    geometry: feature.geometry,
    properties: props,
  };
}

export function toProcessingTable(
  dataStore: PostGISDataStore,
  type: ProcessingTableType,
  batchSize: number = 500,
): Writable {
  let batch: ProcessingFeature[] = [];
  let total = 0;

  const saveBatch = async (features: ProcessingFeature[]): Promise<void> => {
    switch (type) {
      case "ski_areas":
        return dataStore.saveProcessingSkiAreas(features);
      case "runs":
        return dataStore.saveProcessingRuns(features);
      case "lifts":
        return dataStore.saveProcessingLifts(features);
      case "highways":
        return dataStore.saveProcessingHighways(features);
      case "peaks":
        return dataStore.saveProcessingPeaks(features);
    }
  };

  return new Writable({
    objectMode: true,
    async write(
      feature: GeoJSON.Feature,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ) {
      try {
        batch.push(geoJSONFeatureToProcessingFeature(feature));
        if (batch.length >= batchSize) {
          await saveBatch(batch);
          total += batch.length;
          batch = [];
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    async final(callback: (error?: Error | null) => void) {
      try {
        if (batch.length > 0) {
          await saveBatch(batch);
          total += batch.length;
          batch = [];
        }
        Logger.log(`Wrote ${total} ${type} to processing table`);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

export function toOutputTable(
  dataStore: PostGISDataStore,
  type: ProcessingTableType,
  batchSize: number = 500,
): Writable {
  let batch: OutputFeature[] = [];
  let total = 0;

  const saveBatch = async (features: OutputFeature[]): Promise<void> => {
    switch (type) {
      case "ski_areas":
        return dataStore.saveOutputSkiAreas(features);
      case "runs":
        return dataStore.saveOutputRuns(features);
      case "lifts":
        return dataStore.saveOutputLifts(features);
      case "highways":
        return dataStore.saveOutputHighways(features);
      case "peaks":
        return dataStore.saveOutputPeaks(features);
    }
  };

  return new Writable({
    objectMode: true,
    async write(
      feature: GeoJSON.Feature,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ) {
      try {
        batch.push(geoJSONFeatureToOutputFeature(feature));
        if (batch.length >= batchSize) {
          await saveBatch(batch);
          total += batch.length;
          batch = [];
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    async final(callback: (error?: Error | null) => void) {
      try {
        if (batch.length > 0) {
          await saveBatch(batch);
          total += batch.length;
          batch = [];
        }
        Logger.log(`Wrote ${total} ${type} to output table`);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}
