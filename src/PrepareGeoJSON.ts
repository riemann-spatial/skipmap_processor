import { createWriteStream, existsSync, renameSync, unlinkSync } from "fs";
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
} from "./io/GeoPackageWriter";
import { OutputFeature, getPostGISDataStore } from "./io/PostGISDataStore";
import * as CSVFormatter from "./transforms/CSVFormatter";
import { createElevationProcessor } from "./transforms/Elevation";
import toFeatureCollection from "./transforms/FeatureCollection";
import { formatHighway } from "./transforms/HighwayFormatter";
import { formatLift } from "./transforms/LiftFormatter";
import * as MapboxGLFormatter from "./transforms/MapboxGLFormatter";
import { formatRun } from "./transforms/RunFormatter";
import { InputSkiAreaType, formatSkiArea } from "./transforms/SkiAreaFormatter";
import { generate3DTiles } from "./transforms/Tiles3DGenerator";
import { generateTiles } from "./transforms/TilesGenerator";
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
  await performanceMonitor.withPhase(
    "Phase 2: GeoJSON Preparation",
    async () => {
      const siteProvider = new SkiAreaSiteProvider();

      // Create shared elevation processor for ski areas, runs, and lifts
      const elevationTransform = await createElevationTransform(
        config.elevationServer,
        config.postgresCache,
        config.conflateElevation,
      );

      try {
        await performanceMonitor.withOperation(
          "Processing ski areas",
          async () => {
            siteProvider.loadSites(paths.input.osmJSON.skiAreaSites);

            await StreamToPromise(
              merge([
                readGeoJSONFeatures(paths.input.geoJSON.skiAreas).pipe(
                  flatMap(
                    formatSkiArea(InputSkiAreaType.OPENSTREETMAP_LANDUSE),
                  ),
                ),
                Readable.from(siteProvider.getGeoJSONSites()),
                readGeoJSONFeatures(paths.input.geoJSON.skiMapSkiAreas).pipe(
                  flatMap(formatSkiArea(InputSkiAreaType.SKIMAP_ORG)),
                ),
              ])
                .pipe(mapAsync(elevationTransform?.transform || null, 10))
                .pipe(toFeatureCollection())
                .pipe(createWriteStream(paths.intermediate.skiAreas)),
            );
          },
        );

        await performanceMonitor.withOperation("Processing runs", async () => {
          await StreamToPromise(
            readGeoJSONFeatures(paths.input.geoJSON.runs)
              .pipe(flatMapArray(formatRun))
              .pipe(map(addSkiAreaSites(siteProvider)))
              .pipe(accumulate(new RunNormalizerAccumulator()))
              .pipe(mapAsync(elevationTransform?.transform || null, 10))
              .pipe(toFeatureCollection())
              .pipe(createWriteStream(paths.intermediate.runs)),
          );
        });

        // Process snow cover data after runs are written
        await fetchSnowCoverIfEnabled(config, paths.intermediate.runs);

        await performanceMonitor.withOperation("Processing lifts", async () => {
          await StreamToPromise(
            readGeoJSONFeatures(paths.input.geoJSON.lifts)
              .pipe(flatMap(formatLift))
              .pipe(map(addSkiAreaSites(siteProvider)))
              .pipe(mapAsync(elevationTransform?.transform || null, 10))
              .pipe(toFeatureCollection())
              .pipe(createWriteStream(paths.intermediate.lifts)),
          );
        });

        // Process highways if enabled
        if (process.env.COMPILE_HIGHWAY === "1") {
          await performanceMonitor.withOperation(
            "Processing highways",
            async () => {
              await StreamToPromise(
                readGeoJSONFeatures(paths.input.geoJSON.highways)
                  .pipe(flatMapArray(formatHighway))
                  .pipe(mapAsync(elevationTransform?.transform || null, 10))
                  .pipe(toFeatureCollection())
                  .pipe(createWriteStream(paths.intermediate.highways)),
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
                }, 10),
              )
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

  await performanceMonitor.withPhase("Phase 4: Output Generation", async () => {
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
        [FeatureType.SkiArea, FeatureType.Lift, FeatureType.Run].map((type) => {
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
        }),
      );
    });

    await performanceMonitor.withOperation("Creating GeoPackage", async () => {
      // Delete existing GeoPackage if it exists
      if (existsSync(paths.output.geoPackage)) {
        unlinkSync(paths.output.geoPackage);
        console.log("Removed existing GeoPackage file");
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
    });

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

    // Export to PostGIS if enabled
    if (config.output.toPostgis) {
      await performanceMonitor.withOperation(
        "Exporting to PostGIS",
        async () => {
          const dataStore = getPostGISDataStore(config.postgresCache);

          // Reset output tables before writing
          await dataStore.resetOutputTables();

          // Export ski areas
          const skiAreaFeatures: OutputFeature[] = [];
          for await (const feature of readGeoJSONFeaturesAsync(
            paths.output.skiAreas,
          )) {
            skiAreaFeatures.push(geoJSONFeatureToOutputFeature(feature));
          }
          await dataStore.saveOutputSkiAreas(skiAreaFeatures);
          console.log(
            `Exported ${skiAreaFeatures.length} ski areas to PostGIS`,
          );

          // Export runs
          const runFeatures: OutputFeature[] = [];
          for await (const feature of readGeoJSONFeaturesAsync(
            paths.output.runs,
          )) {
            runFeatures.push(geoJSONFeatureToOutputFeature(feature));
          }
          await dataStore.saveOutputRuns(runFeatures);
          console.log(`Exported ${runFeatures.length} runs to PostGIS`);

          // Export lifts
          const liftFeatures: OutputFeature[] = [];
          for await (const feature of readGeoJSONFeaturesAsync(
            paths.output.lifts,
          )) {
            liftFeatures.push(geoJSONFeatureToOutputFeature(feature));
          }
          await dataStore.saveOutputLifts(liftFeatures);
          console.log(`Exported ${liftFeatures.length} lifts to PostGIS`);

          // Export highways if enabled
          if (process.env.COMPILE_HIGHWAY === "1") {
            const highwayFeatures: OutputFeature[] = [];
            for await (const feature of readGeoJSONFeaturesAsync(
              paths.output.highways,
            )) {
              highwayFeatures.push(geoJSONFeatureToOutputFeature(feature));
            }
            await dataStore.saveOutputHighways(highwayFeatures);
            console.log(
              `Exported ${highwayFeatures.length} highways to PostGIS`,
            );
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

  console.log("Done preparing");

  performanceMonitor.logTimeline();
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

async function* readGeoJSONFeaturesAsync(
  filePath: string,
): AsyncGenerator<GeoJSON.Feature> {
  const stream = readGeoJSONFeatures(filePath);

  // Convert Node.js readable stream to async generator using events
  const features: GeoJSON.Feature[] = [];
  let resolve: (() => void) | null = null;
  let reject: ((err: Error) => void) | null = null;
  let done = false;
  let error: Error | null = null;

  stream.on("data", (feature: GeoJSON.Feature) => {
    features.push(feature);
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
    } else if (!done) {
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
