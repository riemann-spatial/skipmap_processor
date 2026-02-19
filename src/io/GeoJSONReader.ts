import { createReadStream } from "fs";
import * as GeoJSON from "geojson";
import * as JSONStream from "JSONStream";

export function readGeoJSONFeatures(path: string): NodeJS.ReadableStream {
  return createReadStream(path, { encoding: "utf8" }).pipe(
    JSONStream.parse("features.*"),
  );
}

export async function* readGeoJSONFeaturesAsync(
  filePath: string,
): AsyncGenerator<GeoJSON.Feature> {
  const stream = readGeoJSONFeatures(filePath);

  // Convert Node.js readable stream to async generator with backpressure.
  // We pause the stream after each data event so features don't accumulate
  // in memory while the consumer is busy (e.g. awaiting a DB write).
  const features: GeoJSON.Feature[] = [];
  let resolve: (() => void) | null = null;
  let reject: ((err: Error) => void) | null = null;
  let done = false;
  let error: Error | null = null;

  stream.on("data", (feature: GeoJSON.Feature) => {
    features.push(feature);
    stream.pause();
    if (resolve) {
      resolve();
      resolve = null;
    }
  });

  stream.on("end", () => {
    done = true;
    if (resolve) {
      resolve();
      resolve = null;
    }
  });

  stream.on("error", (err: Error) => {
    error = err;
    done = true;
    if (reject) {
      reject(err);
      reject = null;
    }
  });

  while (!done || features.length > 0) {
    if (features.length > 0) {
      yield features.shift()!;
      if (features.length === 0 && !done) {
        stream.resume();
      }
    } else if (!done) {
      stream.resume();
      await new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      if (error) {
        throw error;
      }
    }
  }
}
