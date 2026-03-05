import { createWriteStream, existsSync, unlinkSync } from "fs";
import merge from "merge2";
import { FeatureType, SkiAreaFeature } from "openskidata-format";
import * as path from "path";
import { join } from "path";
import { Readable } from "stream";
import StreamToPromise from "stream-to-promise";
import { Config, ElevationServerConfig, PostgresConfig } from "./Config";
import clusterSkiAreas from "./clustering/ClusterSkiAreas";
import { OutputPaths, getPath } from "./io/OutputPaths";
import {
  convertGeoJSONToGeoPackage,
  convertHighwayGeoJSONToGeoPackage,
  convertPeakGeoJSONToGeoPackage,
} from "./io/GeoPackageWriter";
import { PostGISDataStore, getPostGISDataStore } from "./io/PostGISDataStore";
import * as CSVFormatter from "./transforms/CSVFormatter";
import { createElevationProcessor } from "./transforms/Elevation";
import toFeatureCollection from "./transforms/FeatureCollection";
import { PeakFeature } from "./features/PeakFeature";
import { formatHighway } from "./transforms/HighwayFormatter";
import { formatPeak } from "./transforms/PeakFormatter";
import { formatLift } from "./transforms/LiftFormatter";
import * as MapboxGLFormatter from "./transforms/MapboxGLFormatter";
import { toProcessingTable } from "./transforms/ProcessingTableWriter";
import { formatRun } from "./transforms/RunFormatter";
import {
  InputSkiAreaType,
  formatSkiArea,
} from "./transforms/SkiAreaFormatter";
import { generate3DTiles } from "./transforms/Tiles3DGenerator";
import { generateTiles } from "./transforms/TilesGenerator";
import { Logger } from "./utils/Logger";
import { runCommand } from "./utils/ProcessRunner";
import { asyncGeneratorToStream } from "./utils/StreamUtils";

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
  clearCache: boolean = true,
) {
  if (!conflateElevation || !elevationServerConfig) {
    return null;
  }

  const processor = await createElevationProcessor(
    elevationServerConfig,
    postgresConfig,
    { clearCache },
  );
  return { processor, transform: processor.processFeature };
}

async function fetchSnowCoverIfEnabled(
  config: Config,
  dataStore: PostGISDataStore,
  workingDir: string,
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
      // 'full' policy - export temporary GeoJSON from processing.runs for the Python script
      const tempRunsPath = path.join(workingDir, "temp_runs_for_snow.geojson");
      await StreamToPromise(
        asyncGeneratorToStream(dataStore.streamProcessingRuns())
          .pipe(toFeatureCollection())
          .pipe(createWriteStream(tempRunsPath)),
      );
      args.push(tempRunsPath);
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

    // Clean up temporary file
    const tempRunsPath = path.join(workingDir, "temp_runs_for_snow.geojson");
    if (existsSync(tempRunsPath)) {
      unlinkSync(tempRunsPath);
    }
  });
}

export default async function prepare(
  paths: OutputPaths,
  config: Config,
) {
  const dataStore = getPostGISDataStore(config.postgresCache);

  if (config.exportOnly) {
    Logger.log("EXPORT_ONLY mode: skipping processing, jumping to export");

    // Validate that required output tables have data
    const [skiAreaCount, runCount, liftCount] = await Promise.all([
      dataStore.getOutputSkiAreasCount(),
      dataStore.getOutputRunsCount(),
      dataStore.getOutputLiftsCount(),
    ]);
    if (skiAreaCount === 0 && runCount === 0 && liftCount === 0) {
      throw new Error(
        "EXPORT_ONLY mode: output tables are empty. Run a full processing first.",
      );
    }
  }

  if (config.startAtAssociatingHighways) {
    Logger.log(
      "START_AT_ASSOCIATING_HIGHWAYS: skipping to highway association",
    );

    // Validate required output tables exist from previous run
    const [skiAreaCount, runCount, liftCount] = await Promise.all([
      dataStore.getOutputSkiAreasCount(),
      dataStore.getOutputRunsCount(),
      dataStore.getOutputLiftsCount(),
    ]);
    if (skiAreaCount === 0 && runCount === 0 && liftCount === 0) {
      throw new Error(
        "START_AT_ASSOCIATING_HIGHWAYS: output tables are empty. Run clustering first.",
      );
    }

    if (process.env.COMPILE_HIGHWAY === "1") {
      const hwCount = await dataStore.getProcessingHighwaysCount();
      if (hwCount === 0) {
        throw new Error(
          "START_AT_ASSOCIATING_HIGHWAYS: processing.highways table is empty.",
        );
      }
    }
  }

  if (config.continueWithDEM) {
    Logger.log(
      "CONTINUE_WITH_DEM: resuming from elevation step, preserving elevation cache",
    );
  }

  if (config.continueProcessingPeaks) {
    Logger.log(
      "CONTINUE_PROCESSING_PEAKS: skipping to peaks processing step",
    );

    if (!config.localOSMDatabase) {
      throw new Error(
        "CONTINUE_PROCESSING_PEAKS requires local OSM database (COMPILE_LOCAL=1)",
      );
    }

    // Validate that processing tables from previous run exist
    const [skiAreaCount, runCount, liftCount] = await Promise.all([
      dataStore.getProcessingSkiAreasCount(),
      dataStore.getProcessingRunsCount(),
      dataStore.getProcessingLiftsCount(),
    ]);
    if (skiAreaCount === 0 && runCount === 0 && liftCount === 0) {
      throw new Error(
        "CONTINUE_PROCESSING_PEAKS: processing tables are empty. Run Phase 2 first.",
      );
    }
  }

  const skipPhase2 = config.exportOnly || config.startAtAssociatingHighways;
  const skipElevationReapply =
    config.exportOnly || config.startAtAssociatingHighways;

  if (!skipPhase2) {
    const skipPrePeakSteps = config.continueProcessingPeaks;

    await performanceMonitor.withPhase(
      "Phase 2: GeoJSON Preparation",
      async () => {
        const siteProvider = new SkiAreaSiteProvider();

        // Create shared elevation processor for ski areas, runs, and lifts
        // When continuing with DEM or peaks, preserve the PostgreSQL elevation cache
        const preserveElevationCache =
          config.continueWithDEM || config.continueProcessingPeaks;
        const elevationTransform = await createElevationTransform(
          config.elevationServer,
          config.postgresCache,
          config.conflateElevation,
          !preserveElevationCache,
        );

        try {
          // Build the peak elevation transform once (used by peaks pipeline below)
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

          if (!skipPrePeakSteps) {
            // Reset processing tables before writing
            await dataStore.resetProcessingTables();

            // Load ski area sites (needed by ski areas, runs, and lifts pipelines)
            await siteProvider.loadSitesFromDB(dataStore);

            // Query total feature counts for progress reporting
            const countQueries: Promise<number>[] = [
              dataStore.getInputSkiAreasCount(),
              dataStore.getInputRunsCount(),
              dataStore.getInputLiftsCount(),
            ];
            if (process.env.COMPILE_HIGHWAY === "1") {
              countQueries.push(dataStore.getInputHighwaysCount());
            }
            if (config.localOSMDatabase) {
              countQueries.push(dataStore.getInputPeaksCount());
            }
            const counts = await Promise.all(countQueries);
            let i = 0;
            const skiAreaCount = counts[i++];
            const runsCount = counts[i++];
            const liftsCount = counts[i++];
            const highwaysCount =
              process.env.COMPILE_HIGHWAY === "1" ? counts[i++] : 0;
            const peaksCount = config.localOSMDatabase ? counts[i++] : 0;

            // Process all feature types in parallel.
            // They share the elevation processor and tile cache, maximizing
            // cache hits for overlapping geographic areas.
            const progressLabel = elevationTransform
              ? "elevated"
              : "processed";
            const parallelTasks: Promise<void>[] = [];

            parallelTasks.push(
              performanceMonitor.withOperation(
                "Processing ski areas",
                async () => {
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
                      .pipe(mapAsync(elevationTransform?.transform || null, 10))
                      .pipe(logProgress("Ski areas", skiAreaCount, progressLabel))
                      .pipe(toProcessingTable(dataStore, "ski_areas")),
                  );
                },
              ),
            );

            parallelTasks.push(
              (async () => {
                await performanceMonitor.withOperation(
                  "Processing runs",
                  async () => {
                    await StreamToPromise(
                      asyncGeneratorToStream(dataStore.streamInputRuns())
                        .pipe(logProgress("Runs", runsCount, "read"))
                        .pipe(flatMapArray(formatRun))
                        .pipe(map(addSkiAreaSites(siteProvider)))
                        .pipe(accumulate(new RunNormalizerAccumulator()))
                        .pipe(mapAsync(elevationTransform?.transform || null, 10))
                        .pipe(logProgress("Runs", null, progressLabel))
                        .pipe(toProcessingTable(dataStore, "runs")),
                    );
                  },
                );
                // Process snow cover data after runs are written
                await fetchSnowCoverIfEnabled(
                  config,
                  dataStore,
                  config.workingDir,
                );
              })(),
            );

            parallelTasks.push(
              performanceMonitor.withOperation(
                "Processing lifts",
                async () => {
                  await StreamToPromise(
                    asyncGeneratorToStream(dataStore.streamInputLifts())
                      .pipe(flatMap(formatLift))
                      .pipe(map(addSkiAreaSites(siteProvider)))
                      .pipe(mapAsync(elevationTransform?.transform || null, 10))
                      .pipe(logProgress("Lifts", liftsCount, progressLabel))
                      .pipe(toProcessingTable(dataStore, "lifts")),
                  );
                },
              ),
            );

            if (process.env.COMPILE_HIGHWAY === "1") {
              parallelTasks.push(
                performanceMonitor.withOperation(
                  "Processing highways",
                  async () => {
                    await StreamToPromise(
                      asyncGeneratorToStream(dataStore.streamInputHighways())
                        .pipe(flatMapArray(formatHighway))
                        .pipe(
                          mapAsync(elevationTransform?.transform || null, 10),
                        )
                        .pipe(logProgress("Highways", highwaysCount, progressLabel))
                        .pipe(toProcessingTable(dataStore, "highways")),
                    );
                  },
                ),
              );
            }

            if (config.localOSMDatabase) {
              parallelTasks.push(
                performanceMonitor.withOperation(
                  "Processing peaks",
                  async () => {
                    await StreamToPromise(
                      asyncGeneratorToStream(dataStore.streamInputPeaks())
                        .pipe(flatMapArray(formatPeak))
                        .pipe(mapAsync(peakElevationTransform, 10))
                        .pipe(logProgress("Peaks", peaksCount, progressLabel))
                        .pipe(toProcessingTable(dataStore, "peaks")),
                    );
                  },
                ),
              );
            }

            await Promise.all(parallelTasks);
          } else if (config.localOSMDatabase) {
            // continueProcessingPeaks mode: only process peaks
            const peaksCount = await dataStore.getInputPeaksCount();
            const peakProgressLabel = peakElevationTransform
              ? "elevated"
              : "processed";

            await performanceMonitor.withOperation(
              "Processing peaks",
              async () => {
                await StreamToPromise(
                  asyncGeneratorToStream(dataStore.streamInputPeaks())
                    .pipe(flatMapArray(formatPeak))
                    .pipe(mapAsync(peakElevationTransform, 10))
                    .pipe(logProgress("Peaks", peaksCount, peakProgressLabel))
                    .pipe(toProcessingTable(dataStore, "peaks")),
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

  } // end if (!skipPhase2)

  if (!config.exportOnly) {
    await performanceMonitor.withPhase("Phase 3: Clustering", async () => {
      await clusterSkiAreas(dataStore, config, process.env.COMPILE_HIGHWAY === "1");
    });

    if (
      !skipElevationReapply &&
      config.conflateElevation &&
      config.elevationServer
    ) {
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
            for await (const feature of dataStore.streamOutputSkiAreas()) {
              const skiArea = feature as SkiAreaFeature;
              if (
                skiArea.geometry.type !== "Point" &&
                skiArea.geometry.type !== "MultiPolygon"
              ) {
                continue;
              }
              const elevated = await processor.processFeature(skiArea);
              await dataStore.updateOutputSkiAreaGeometry(
                elevated.properties.id,
                elevated.geometry,
              );
            }
          } finally {
            await processor.close();
          }
        },
      );
    }

    // Copy processing peaks to output (peaks skip clustering, so copy after
    // resetOutputTables has run inside clustering)
    if (config.localOSMDatabase) {
      const peaksCount = await dataStore.getProcessingPeaksCount();
      if (peaksCount > 0) {
        await dataStore.copyPeaksFromProcessingToOutput();
      }
    }

    // Create 2D views after output tables are populated
    await dataStore.createOutput2DViews();
  } // end if (!config.exportOnly)

  await performanceMonitor.withPhase("Phase 4: Output Generation", async () => {
    if (!config.exportOnly && config.output.toFiles) {
      await performanceMonitor.withOperation(
        "Exporting to Mapbox GeoJSON",
        async () => {
          const streamForType = (type: FeatureType) => {
            switch (type) {
              case FeatureType.SkiArea:
                return asyncGeneratorToStream(dataStore.streamOutputSkiAreas());
              case FeatureType.Lift:
                return asyncGeneratorToStream(dataStore.streamOutputLifts());
              case FeatureType.Run:
                return asyncGeneratorToStream(dataStore.streamOutputRuns());
            }
            throw new Error(`Unhandled feature type: ${type}`);
          };

          await Promise.all(
            [FeatureType.SkiArea, FeatureType.Lift, FeatureType.Run].map(
              (type) => {
                return StreamToPromise(
                  streamForType(type)
                    .pipe(flatMap(MapboxGLFormatter.formatter(type)))
                    .pipe(toFeatureCollection())
                    .pipe(
                      createWriteStream(getPath(paths.mapboxGL, type)),
                    ),
                );
              },
            ),
          );
        },
      );

      // Export highways MapboxGL if enabled
      if (process.env.COMPILE_HIGHWAY === "1") {
        await StreamToPromise(
          asyncGeneratorToStream(dataStore.streamOutputHighways())
            .pipe(toFeatureCollection())
            .pipe(createWriteStream(paths.mapboxGL.highways)),
        );
      }

      await performanceMonitor.withOperation("Exporting to CSV", async () => {
        const streamForType = (type: FeatureType) => {
          switch (type) {
            case FeatureType.SkiArea:
              return asyncGeneratorToStream(dataStore.streamOutputSkiAreas());
            case FeatureType.Lift:
              return asyncGeneratorToStream(dataStore.streamOutputLifts());
            case FeatureType.Run:
              return asyncGeneratorToStream(dataStore.streamOutputRuns());
          }
          throw new Error(`Unhandled feature type: ${type}`);
        };

        await Promise.all(
          [FeatureType.SkiArea, FeatureType.Lift, FeatureType.Run].map(
            (type) => {
              return StreamToPromise(
                streamForType(type)
                  .pipe(flatMap(CSVFormatter.formatter(type)))
                  .pipe(CSVFormatter.createCSVWriteStream(type))
                  .pipe(
                    createWriteStream(
                      join(paths.csv, CSVFormatter.getCSVFilename(type)),
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
          if (existsSync(paths.geoPackage)) {
            unlinkSync(paths.geoPackage);
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
              dataStore,
              paths.geoPackage,
              layerMap[type],
              type,
            );
          }

          // Add highways if enabled
          if (process.env.COMPILE_HIGHWAY === "1") {
            await convertHighwayGeoJSONToGeoPackage(
              dataStore,
              paths.geoPackage,
              "highways",
            );
          }

          // Add peaks if local OSM database is configured
          if (config.localOSMDatabase) {
            const peaksCount = await dataStore.getOutputPeaksCount();
            if (peaksCount > 0) {
              await convertPeakGeoJSONToGeoPackage(
                dataStore,
                paths.geoPackage,
                "peaks",
              );
            }
          }
        },
      );

      // Generate tiles if enabled
      const tilesConfig = config.tiles;
      if (tilesConfig) {
        await performanceMonitor.withOperation("Generating tiles", async () => {
          await generateTiles(
            paths.mapboxGL,
            config.workingDir,
            tilesConfig,
          );
        });
      }
    } // end if (!config.exportOnly && config.output.toFiles) within Phase 4

    // Generate 3D Tiles if enabled (requires output tables)
    const tiles3DConfig = config.tiles3D;
    if (tiles3DConfig) {
      await performanceMonitor.withOperation(
        "Generating 3D Tiles",
        async () => {
          await generate3DTiles(config.postgresCache, tiles3DConfig);
        },
      );
    }
  });

  Logger.log("Done preparing");

  performanceMonitor.logTimeline();
}
