import { configFromEnvironment } from "../Config";
import { OutputPaths } from "../io/OutputPaths";
import prepare from "../PrepareSkiData";
import { Logger } from "../utils/Logger";

const config = configFromEnvironment();

prepare(new OutputPaths(config.outputDir), config).catch((reason: unknown) => {
  Logger.log("Failed preparing", reason);
  process.exit(1);
});
