import transform from "parallel-transform";
import { Duplex, PassThrough, Transform, Writable } from "stream";
import { Logger } from "../utils/Logger";
import Accumulator from "./accumulator/Accumulator";

export function map<X, Y>(mapper: (input: X) => Y): Transform {
  return new Transform({
    objectMode: true,
    transform: (data: X, _, done) => {
      done(null, mapper(data));
    },
  });
}

export function mapAsync<X, Y>(
  mapper: ((input: X) => Promise<Y>) | null,
  parallelism: number = 1,
): Transform {
  if (!mapper) {
    return passThrough();
  }
  return transform(parallelism, { objectMode: true }, (data, done) => {
    mapper(data)
      .then((value) => {
        done(null, value);
      })
      .catch((error) => {
        done(error);
      });
  });
}

export function get<X>(operation: (input: X) => void): Transform {
  return new Transform({
    objectMode: true,
    transform: (data: X, _, done) => {
      operation(data);
      done(null, data);
    },
  });
}

export function andFinally<X>(mapper: (input: X) => Promise<void>): Writable {
  return new Writable({
    objectMode: true,
    write: (data: X, _, done) => {
      mapper(data)
        .then((value) => {
          done();
        })
        .catch((error) => {
          done(error);
        });
    },
  });
}

export function flatMap<X, Y>(mapper: (input: X) => Y | null): Transform {
  return new Transform({
    objectMode: true,
    transform: (data: X, _, done) => {
      const result = mapper(data);

      result ? done(null, result) : done(null);
    },
  });
}

export function flatMapArray<X, Y>(mapper: (input: X) => Y[]): Transform {
  return new Transform({
    objectMode: true,
    transform: function (data: X, _, done) {
      const results = mapper(data);

      // Push each item in the array separately
      results.forEach((item) => this.push(item));
      done(null);
    },
  });
}

export function filter<X>(filter: (input: X) => Boolean): Transform {
  return new Transform({
    objectMode: true,
    transform: (data: X, _, done) => {
      filter(data) ? done(null, data) : done(null);
    },
  });
}

export function accumulate<X, Y>(accumulator: Accumulator<X, Y>): Duplex {
  const duplex = new Duplex({
    readableObjectMode: true,
    writableObjectMode: true,
    write: (data: X, _, done) => {
      accumulator.accumulate(data);
      done();
    },
    read() {},
  });
  duplex.on("finish", () => {
    accumulator.results().forEach((result) => {
      duplex.push(result);
    });
    duplex.push(null);
  });

  return duplex;
}

export function logProgress(label: string, total: number | null): Transform {
  let processed = 0;
  let lastLoggedPctStep = -1;
  const PCT_STEP = 5;

  return new Transform({
    objectMode: true,
    transform(data, _, done) {
      processed++;

      if (total !== null && total > 0) {
        const pctStep = Math.floor(((processed / total) * 100) / PCT_STEP);
        if (pctStep > lastLoggedPctStep) {
          lastLoggedPctStep = pctStep;
          const pct = ((processed / total) * 100).toFixed(1);
          Logger.log(`${label}: ${processed}/${total} (${pct}%)`);
        }
      }

      done(null, data);
    },
    flush(done) {
      if (total !== null && total > 0) {
        Logger.log(`${label}: done — ${processed}/${total}`);
      } else {
        Logger.log(`${label}: done — ${processed} total`);
      }
      done();
    },
  });
}

export function passThrough(): Transform {
  return new PassThrough({ objectMode: true });
}
