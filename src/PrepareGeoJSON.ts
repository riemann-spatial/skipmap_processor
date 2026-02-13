import {
  copyFileSync,
  createWriteStream,
  existsSync,
  renameSync,
  unlinkSync,
} from "fs";
import merge from "merge2";
import { FeatureType, SkiAreaFeature } from "openskidata-format";
import * as path from "path";
import { join } from "path";
import { Readable } from "stream";
import StreamToPromise from "stream-to-promise";
import { Config, ElevationServerConfig, PostgresConfig } from "./Config";
import clusterSkiAreas from "./clustering/ClusterSkiAreas";
import { DataPaths, getPath } from "./io/GeoJSONFiles";
import { readGeoJSONFeatures } from "./io/GeoJSONReader";
import {
  convertGeoJSONToGeoPackage,
  convertHighwayGeoJSONToGeoPackage,
  convertPeakGeoJSONToGeoPackage,
} from "./io/GeoPackageWriter";
import {
  OutputFeature,
  PostGISDataStore,
  getPostGISDataStore,
} from "./io/PostGISDataStore";
import * as CSVFormatter from "./transforms/CSVFormatter";
import { createElevationProcessor } from "./transforms/Elevation";
import toFeatureCollection from "./transforms/FeatureCollection";
import { PeakFeature } from "./features/PeakFeature";
import { formatHighway } from "./transforms/HighwayFormatter";
import { formatPeak } from "./transforms/PeakFormatter";
import { formatLift } from "./transforms/LiftFormatter";
import * as MapboxGLFormatter from "./transforms/MapboxGLFormatter";
import { formatRun } from "./transforms/RunFormatter";
import { InputSkiAreaType, formatSkiArea } from "./transforms/SkiAreaFormatter";
import { generate3DTiles } from "./transforms/Tiles3DGenerator";
import { generateTiles } from "./transforms/TilesGenerator";
import { Logger } from "./utils/Logger";
import { runCommand } from "./utils/ProcessRunner";

import { performanceMonitor } from "./clustering/database/PerformanceMonitor";
import {
  SkiAreaSiteProvider,
  addSkiAreaSites,
} from "./transforms/SkiAreaSiteProvider";
import {
  accumulate,
  flatMap,
  flatMapArray,
  logProgress,
  map,
  mapAsync,
} from "./transforms/StreamTransforms";
import { RunNormalizerAccumulator } from "./transforms/accumulator/RunNormalizerAccumulator";

async function createElevationTransform(
  elevationServerConfig: ElevationServerConfig | null,
  postgresConfig: PostgresConfig,
  conflateElevation: boolean,
) {
  if (!conflateElevation || !elevationServerConfig) {
    return null;
  }

  const processor = await createElevationProcessor(
    elevationServerConfig,
    postgresConfig,
    { clearCache: true },
  );
  return { processor, transform: processor.processFeature };
}

async function fetchSnowCoverIfEnabled(
  config: Config,
  runsPath: string,
): Promise<void> {
  const snowCoverConfig = config.snowCover;
  if (!snowCoverConfig || snowCoverConfig.fetchPolicy === "none") {
    return;
  }

  await performanceMonitor.withOperation("Processing snow cover", async () => {
    const args = ["snow-cover/src/fetch_snow_data.py"];

    if (snowCoverConfig.fetchPolicy === "incremental") {
      args.push("--fill-cache");
    } else {
      // 'full' policy - pass the runs geojson path
      args.push(runsPath);
    }

    // Determine which Python executable to use
    let pythonExecutable = "python3"; // Default fallback

    // Check if virtual environment exists and use it
    const venvPython = path.join("snow-cover", "venv", "bin", "python");
    if (existsSync(venvPython)) {
      pythonExecutable = "snow-cover/venv/bin/python";
    }

    try {
      await runCommand(pythonExecutable, args);
    } catch (error) {
      throw new Error(`Snow cover processing failed: ${error}`);
    }
  });
}

export default async function prepare(paths: DataPaths, config: Config) {
  if (config.exportOnly) {
    Logger.log("EXPORT_ONLY mode: skipping processing, jumping to export");

    // Validate that required output files exist
    const requiredFiles = [
      paths.output.skiAreas,
      paths.output.runs,
      paths.output.lifts,
    ];
    for (const filePath of requiredFiles) {
      if (!existsSync(filePath)) {
        throw new Error(
          `EXPORT_ONLY mode: required output file not found: ${filePath}`,
        );
      }
    }
  }

  if (!config.exportOnly) {
    await performanceMonitor.withPhase(
      "Phase 2: GeoJSON Preparation",
      async () => {
        const dataStore = getPostGISDataStore(config.postgresCache);
        const siteProvider = new SkiAreaSiteProvider();

        // Create shared elevation processor for ski areas, runs, and lifts
        const elevationTransform = await createElevationTransform(
          config.elevationServer,
          config.postgresCache,
          config.conflateElevation,
        );

        try {
          // Query total feature counts for progress reporting
          const [
            skiAreaCount,
            runsCount,
            liftsCount,
            highwaysCount,
            peaksCount,
          ] = await Promise.all([
            dataStore.getInputSkiAreasCount(),
            dataStore.getInputRunsCount(),
            dataStore.getInputLiftsCount(),
            process.env.COMPILE_HIGHWAY === "1"
              ? dataStore.getInputHighwaysCount()
              : Promise.resolve(0),
            config.localOSMDatabase
              ? dataStore.getInputPeaksCount()
              : Promise.resolve(0),
          ]);

          await performanceMonitor.withOperation(
            "Processing ski areas",
            async () => {
              await siteProvider.loadSitesFromDB(dataStore);

              await StreamToPromise(
                merge([
                  asyncGeneratorToStream(
                    dataStore.streamInputSkiAreas("openstreetmap"),
                  ).pipe(
                    flatMap(
                      formatSkiArea(InputSkiAreaType.OPENSTREETMAP_LANDUSE),
                    ),
                  ),
                  Readable.from(siteProvider.getGeoJSONSites()),
                  asyncGeneratorToStream(
                    dataStore.streamInputSkiAreas("skimap"),
                  ).pipe(flatMap(formatSkiArea(InputSkiAreaType.SKIMAP_ORG))),
                ])
                  .pipe(mapAsync(elevationTransform?.transform || null, 30))
                  .pipe(logProgress("Ski areas", skiAreaCount))
                  .pipe(toFeatureCollection())
                  .pipe(createWriteStream(paths.intermediate.skiAreas)),
              );
            },
          );

          // Process runs, lifts, and highways in parallel.
          // They share the elevation processor and tile cache, maximizing
          // cache hits for overlapping geographic areas.
          const runsPromise = (async () => {
            await performanceMonitor.withOperation(
              "Processing runs",
              async () => {
                await StreamToPromise(
                  asyncGeneratorToStream(dataStore.streamInputRuns())
                    .pipe(flatMapArray(formatRun))
                    .pipe(map(addSkiAreaSites(siteProvider)))
                    .pipe(accumulate(new RunNormalizerAccumulator()))
                    .pipe(mapAsync(elevationTransform?.transform || null, 30))
                    .pipe(logProgress("Runs", runsCount))
                    .pipe(toFeatureCollection())
                    .pipe(createWriteStream(paths.intermediate.runs)),
                );
              },
            );
            // Process snow cover data after runs are written
            await fetchSnowCoverIfEnabled(config, paths.intermediate.runs);
          })();

          const liftsPromise = performanceMonitor.withOperation(
            "Processing lifts",
            async () => {
              await StreamToPromise(
                asyncGeneratorToStream(dataStore.streamInputLifts())
                  .pipe(flatMap(formatLift))
                  .pipe(map(addSkiAreaSites(siteProvider)))
                  .pipe(mapAsync(elevationTransform?.transform || null, 30))
                  .pipe(logProgress("Lifts", liftsCount))
                  .pipe(toFeatureCollection())
                  .pipe(createWriteStream(paths.intermediate.lifts)),
              );
            },
          );

          const parallelTasks: Promise<void>[] = [runsPromise, liftsPromise];

          // Process highways if enabled
          if (process.env.COMPILE_HIGHWAY === "1") {
            parallelTasks.push(
              performanceMonitor.withOperation(
                "Processing highways",
                async () => {
                  await StreamToPromise(
                    asyncGeneratorToStream(dataStore.streamInputHighways())
                      .pipe(flatMapArray(formatHighway))
                      .pipe(mapAsync(elevationTransform?.transform || null, 30))
                      .pipe(logProgress("Highways", highwaysCount))
                      .pipe(toFeatureCollection())
                      .pipe(createWriteStream(paths.intermediate.highways)),
                  );
                },
              ),
            );
          }

          await Promise.all(parallelTasks);

          // Process peaks if local OSM database is configured
          // (runs after parallel tasks since peaks need the shared elevation processor)
          if (config.localOSMDatabase) {
            await performanceMonitor.withOperation(
              "Processing peaks",
              async () => {
                const peakElevationTransform = elevationTransform
                  ? async (feature: PeakFeature): Promise<PeakFeature> => {
                      if (feature.properties.elevation !== null) {
                        // OSM ele tag is valid, skip DEM lookup
                        return feature;
                      }
                      const result =
                        await elevationTransform.transform(feature);
                      const peakResult = result as PeakFeature;
                      if (
                        peakResult.geometry.coordinates.length >= 3 &&
                        Number.isFinite(peakResult.geometry.coordinates[2])
                      ) {
                        peakResult.properties.elevation =
                          peakResult.geometry.coordinates[2];
                        peakResult.properties.elevationSource = "dem";
                      }
                      return peakResult;
                    }
                  : null;

                await StreamToPromise(
                  asyncGeneratorToStream(dataStore.streamInputPeaks())
                    .pipe(flatMapArray(formatPeak))
                    .pipe(mapAsync(peakElevationTransform, 10))
                    .pipe(logProgress("Peaks", peaksCount))
                    .pipe(toFeatureCollection())
                    .pipe(createWriteStream(paths.intermediate.peaks)),
                );
              },
            );
          }
        } finally {
          if (elevationTransform) {
            await elevationTransform.processor.close();
          }
        }
      },
    );

    // Copy intermediate peaks to output (peaks skip clustering)
    if (config.localOSMDatabase && existsSync(paths.intermediate.peaks)) {
      copyFileSync(paths.intermediate.peaks, paths.output.peaks);
    }

    await performanceMonitor.withPhase("Phase 3: Clustering", async () => {
      await clusterSkiAreas(
        paths.intermediate,
        paths.output,
        config,
        process.env.COMPILE_HIGHWAY === "1",
      );
    });

    if (config.conflateElevation && config.elevationServer) {
      await performanceMonitor.withOperation(
        "Re-applying elevation to ski area points",
        async () => {
          const elevationServerConfig = config.elevationServer;
          if (!elevationServerConfig) {
            return;
          }
          const processor = await createElevationProcessor(
            elevationServerConfig,
            config.postgresCache,
            { clearCache: false },
          );
          try {
            const tempPath = `${paths.output.skiAreas}.tmp`;
            await StreamToPromise(
              readGeoJSONFeatures(paths.output.skiAreas)
                .pipe(
                  mapAsync(async (feature) => {
                    const skiArea = feature as SkiAreaFeature;
                    if (
                      skiArea.geometry.type !== "Point" &&
                      skiArea.geometry.type !== "MultiPolygon"
                    ) {
                      return skiArea;
                    }
                    return await processor.processFeature(skiArea);
                  }, 30),
                )
                .pipe(logProgress("Ski areas (re-elevation)", null))
                .pipe(toFeatureCollection())
                .pipe(createWriteStream(tempPath)),
            );
            renameSync(tempPath, paths.output.skiAreas);
          } finally {
            await processor.close();
          }
        },
      );
    }
  } // end if (!config.exportOnly)

  await performanceMonitor.withPhase("Phase 4: Output Generation", async () => {
    if (!config.exportOnly) {
      await performanceMonitor.withOperation(
        "Exporting to Mapbox GeoJSON",
        async () => {
          await Promise.all(
            [FeatureType.SkiArea, FeatureType.Lift, FeatureType.Run].map(
              (type) => {
                return StreamToPromise(
                  readGeoJSONFeatures(getPath(paths.output, type))
                    .pipe(flatMap(MapboxGLFormatter.formatter(type)))
                    .pipe(toFeatureCollection())
                    .pipe(
                      createWriteStream(getPath(paths.output.mapboxGL, type)),
                    ),
                );
              },
            ),
          );
        },
      );

      await performanceMonitor.withOperation("Exporting to CSV", async () => {
        await Promise.all(
          [FeatureType.SkiArea, FeatureType.Lift, FeatureType.Run].map(
            (type) => {
              return StreamToPromise(
                readGeoJSONFeatures(getPath(paths.output, type))
                  .pipe(flatMap(CSVFormatter.formatter(type)))
                  .pipe(CSVFormatter.createCSVWriteStream(type))
                  .pipe(
                    createWriteStream(
                      join(paths.output.csv, CSVFormatter.getCSVFilename(type)),
                    ),
                  ),
              );
            },
          ),
        );
      });

      await performanceMonitor.withOperation(
        "Creating GeoPackage",
        async () => {
          // Delete existing GeoPackage if it exists
          if (existsSync(paths.output.geoPackage)) {
            unlinkSync(paths.output.geoPackage);
            Logger.log("Removed existing GeoPackage file");
          }

          // Create a single GeoPackage with all three layers
          const layerMap = {
            [FeatureType.SkiArea]: "ski_areas",
            [FeatureType.Lift]: "lifts",
            [FeatureType.Run]: "runs",
          };

          for (const type of [
            FeatureType.SkiArea,
            FeatureType.Lift,
            FeatureType.Run,
          ]) {
            await convertGeoJSONToGeoPackage(
              getPath(paths.output, type),
              paths.output.geoPackage,
              layerMap[type],
              type,
            );
          }

          // Add highways if enabled
          if (process.env.COMPILE_HIGHWAY === "1") {
            await convertHighwayGeoJSONToGeoPackage(
              paths.output.highways,
              paths.output.geoPackage,
              "highways",
            );
          }

          // Add peaks if local OSM database is configured
          if (config.localOSMDatabase && existsSync(paths.output.peaks)) {
            await convertPeakGeoJSONToGeoPackage(
              paths.output.peaks,
              paths.output.geoPackage,
              "peaks",
            );
          }
        },
      );

      // Generate tiles if enabled
      const tilesConfig = config.tiles;
      if (tilesConfig) {
        await performanceMonitor.withOperation("Generating tiles", async () => {
          await generateTiles(
            paths.output.mapboxGL,
            config.workingDir,
            tilesConfig,
          );
        });
      }
    } // end if (!config.exportOnly) within Phase 4

    // Export to PostGIS if enabled
    if (config.output.toPostgis) {
      await performanceMonitor.withOperation(
        "Exporting to PostGIS",
        async () => {
          const dataStore = getPostGISDataStore(config.postgresCache);

          // Reset output tables before writing
          await dataStore.resetOutputTables();

          // Export ski areas
          const skiAreaCount = await exportFeaturesToPostGIS(
            paths.output.skiAreas,
            (batch) => dataStore.saveOutputSkiAreas(batch),
            "Ski areas",
          );
          Logger.log(`Exported ${skiAreaCount} ski areas to PostGIS`);

          // Export runs
          const runCount = await exportFeaturesToPostGIS(
            paths.output.runs,
            (batch) => dataStore.saveOutputRuns(batch),
            "Runs",
          );
          Logger.log(`Exported ${runCount} runs to PostGIS`);

          // Export lifts
          const liftCount = await exportFeaturesToPostGIS(
            paths.output.lifts,
            (batch) => dataStore.saveOutputLifts(batch),
            "Lifts",
          );
          Logger.log(`Exported ${liftCount} lifts to PostGIS`);

          // Export highways if enabled
          if (process.env.COMPILE_HIGHWAY === "1") {
            const highwayCount = await exportFeaturesToPostGIS(
              paths.output.highways,
              (batch) => dataStore.saveOutputHighways(batch),
              "Highways",
            );
            Logger.log(`Exported ${highwayCount} highways to PostGIS`);
          }

          // Export peaks if local OSM database is configured
          if (config.localOSMDatabase && existsSync(paths.output.peaks)) {
            const peakCount = await exportFeaturesToPostGIS(
              paths.output.peaks,
              (batch) => dataStore.saveOutputPeaks(batch),
              "Peaks",
            );
            Logger.log(`Exported ${peakCount} peaks to PostGIS`);
          }

          await dataStore.createOutput2DViews();
        },
      );

      // Generate 3D Tiles if enabled (requires PostGIS export)
      const tiles3DConfig = config.tiles3D;
      if (tiles3DConfig) {
        await performanceMonitor.withOperation(
          "Generating 3D Tiles",
          async () => {
            await generate3DTiles(config.postgresCache, tiles3DConfig);
          },
        );
      }
    }
  });

  Logger.log("Done preparing");

  performanceMonitor.logTimeline();
}

function asyncGeneratorToStream<T>(generator: AsyncGenerator<T>): Readable {
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

async function exportFeaturesToPostGIS(
  filePath: string,
  saveBatch: (features: OutputFeature[]) => Promise<void>,
  label: string,
): Promise<number> {
  const batchSize = 10000;
  let batch: OutputFeature[] = [];
  let total = 0;

  for await (const feature of readGeoJSONFeaturesAsync(filePath)) {
    batch.push(geoJSONFeatureToOutputFeature(feature));
    if (batch.length >= batchSize) {
      await saveBatch(batch);
      total += batch.length;
      batch = [];
      Logger.log(`  ${label}: exported ${total} so far`);
    }
  }
  if (batch.length > 0) {
    await saveBatch(batch);
    total += batch.length;
  }
  return total;
}

async function* readGeoJSONFeaturesAsync(
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
