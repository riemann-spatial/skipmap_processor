import { configFromEnvironment } from "../Config";
import downloadAndConvertToGeoJSON from "../io/GeoJSONDownloader";
import { Logger } from "../utils/Logger";

const config = configFromEnvironment();

downloadAndConvertToGeoJSON(config.workingDir, config.bbox).catch(
  (reason: any) => {
    Logger.log("Failed downloading", reason);
    process.exit(1);
  },
);
