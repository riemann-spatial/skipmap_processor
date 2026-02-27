import { SkiAreaFeature } from "openskidata-format";
import { Readable } from "stream";
import streamToPromise from "stream-to-promise";
import { PostGISDataStore } from "../io/PostGISDataStore";
import { toOutputTable } from "../transforms/ProcessingTableWriter";
import { map } from "../transforms/StreamTransforms";
import { Logger } from "../utils/Logger";
import { SkiAreaObject } from "./MapObject";
import objectToFeature from "./ObjectToFeature";
import { ClusteringDatabase } from "./database/ClusteringDatabase";

export default async function exportSkiAreas(
  dataStore: PostGISDataStore,
  database: ClusteringDatabase,
) {
  const skiAreasIterable = await database.streamSkiAreas();

  await streamToPromise(
    asyncIterableToStream(skiAreasIterable)
      .pipe(map<SkiAreaObject, SkiAreaFeature>(objectToFeature))
      .pipe(toOutputTable(dataStore, "ski_areas")),
  );
}

function asyncIterableToStream(
  iterable: AsyncIterable<SkiAreaObject>,
): Readable {
  const iterator = iterable[Symbol.asyncIterator]();

  return new Readable({
    objectMode: true,
    read: function (this: Readable, _) {
      const readable = this;
      iterator
        .next()
        .catch((_: unknown) => {
          Logger.log("Failed reading from database, stopping.");
          readable.push(null);
          return undefined as IteratorResult<SkiAreaObject> | undefined;
        })
        .then((result: IteratorResult<SkiAreaObject> | undefined) => {
          if (result) {
            readable.push(result.done ? null : result.value);
          }
        });
    },
  });
}
