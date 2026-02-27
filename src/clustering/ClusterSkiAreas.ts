import { Config } from "../Config";
import { PostGISDataStore } from "../io/PostGISDataStore";
import { PostgreSQLClusteringDatabase } from "./database/PostgreSQLClusteringDatabase";
import { SkiAreaClusteringService } from "./SkiAreaClusteringService";

export default async function clusterSkiAreas(
  dataStore: PostGISDataStore,
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
        dataStore,
        config.geocodingServer,
        config.snowCover,
        config.postgresCache,
      );
    }

    // Process highways if enabled - associate with ski areas
    if (processHighways) {
      const bufferMeters = config.localOSMDatabase?.bufferMeters ?? 1000;
      await clusteringService.associateHighwaysWithSkiAreas(
        dataStore,
        bufferMeters,
      );
    }
  } finally {
    await database.close();
  }
}
