import { Readable } from "stream";
import { Logger } from "./Logger";

export function asyncGeneratorToStream<T>(generator: AsyncGenerator<T>): Readable {
  const iterator = generator[Symbol.asyncIterator]();

  return new Readable({
    objectMode: true,
    read: function (this: Readable, _) {
      const readable = this;
      iterator
        .next()
        .catch((_: unknown) => {
          Logger.log("Failed reading from database, stopping.");
          readable.push(null);
          return undefined as IteratorResult<T> | undefined;
        })
        .then((result: IteratorResult<T> | undefined) => {
          if (result) {
            readable.push(result.done ? null : result.value);
          }
        });
    },
  });
}
