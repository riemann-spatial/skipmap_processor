import { configFromEnvironment } from "../Config";
import {
  GeoJSONIntermediatePaths,
  GeoJSONOutputPaths,
} from "../io/GeoJSONFiles";
import prepare from "../PrepareGeoJSON";
import { Logger } from "../utils/Logger";

const config = configFromEnvironment();

prepare(
  {
    intermediate: new GeoJSONIntermediatePaths(config.workingDir),
    output: new GeoJSONOutputPaths(config.outputDir),
  },
  config,
).catch((reason: any) => {
  Logger.log("Failed preparing", reason);
  process.exit(1);
});
