import { configFromEnvironment } from "../Config";
import downloadAndStoreSkiData from "../io/SkiDataDownloader";
import { Logger } from "../utils/Logger";

const config = configFromEnvironment();

downloadAndStoreSkiData(config.workingDir, config.bbox).catch(
  (reason: any) => {
    Logger.log("Failed downloading", reason);
    process.exit(1);
  },
);
