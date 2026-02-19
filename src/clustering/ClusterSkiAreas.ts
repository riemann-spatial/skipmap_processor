import { Config } from "../Config";
import {
  GeoJSONIntermediatePaths,
  GeoJSONOutputPaths,
} from "../io/GeoJSONFiles";
import { PostgreSQLClusteringDatabase } from "./database/PostgreSQLClusteringDatabase";
import { SkiAreaClusteringService } from "./SkiAreaClusteringService";

export default async function clusterSkiAreas(
  intermediatePaths: GeoJSONIntermediatePaths,
  outputPaths: GeoJSONOutputPaths,
  config: Config,
  processHighways: boolean = false,
): Promise<void> {
  const skipToHighways = config.startAtAssociatingHighways;
  const database = new PostgreSQLClusteringDatabase(config.postgresCache);
  const clusteringService = new SkiAreaClusteringService(database);

  try {
    await database.initialize(
      skipToHighways ? { skipTruncate: true } : undefined,
    );

    if (!skipToHighways) {
      await clusteringService.clusterSkiAreas(
        intermediatePaths.skiAreas,
        intermediatePaths.lifts,
        intermediatePaths.runs,
        outputPaths.skiAreas,
        outputPaths.lifts,
        outputPaths.runs,
        config.geocodingServer,
        config.snowCover,
        config.postgresCache,
      );
    }

    // Process highways if enabled - associate with ski areas
    if (processHighways) {
      const bufferMeters = config.localOSMDatabase?.bufferMeters ?? 1000;
      await clusteringService.associateHighwaysWithSkiAreas(
        intermediatePaths.highways,
        outputPaths.highways,
        outputPaths.skiAreas,
        bufferMeters,
      );
    }
  } finally {
    await database.close();
  }
}
