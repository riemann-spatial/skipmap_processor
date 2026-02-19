import { Pool } from "pg";
import { LocalOSMDatabaseConfig, PostgresConfig } from "../Config";
import { getPostgresPoolConfig } from "../utils/getPostgresPoolConfig";
import { Logger } from "../utils/Logger";
import { computeClusterBuffers } from "./LocalOSMClusterBuffers";
import { InputFeature, PostGISDataStore } from "./PostGISDataStore";

export async function fetchPeaksFromLocalDB(
  processingDbConfig: PostgresConfig,
  localDbConfig: LocalOSMDatabaseConfig,
  dataStore: PostGISDataStore,
  bufferMeters?: number,
): Promise<number> {
  const processingPool = new Pool(
    getPostgresPoolConfig(
      processingDbConfig.processingDatabase,
      processingDbConfig,
    ),
  );

  const localPool = new Pool({
    host: localDbConfig.host,
    port: localDbConfig.port,
    database: localDbConfig.database,
    user: localDbConfig.user,
    password: localDbConfig.password,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  try {
    Logger.log(
      "Computing buffered envelopes around ski feature clusters for local peak query...",
    );
    const clusterBuffers = await computeClusterBuffers(
      processingPool,
      bufferMeters,
    );
    Logger.log(`Found ${clusterBuffers.length} ski feature cluster(s).`);

    if (clusterBuffers.length === 0) {
      Logger.log("No ski features found, skipping local peak query.");
      return 0;
    }

    Logger.log("Querying peaks from local OSM planet database...");
    const seenIds = new Set<number>();
    let totalCount = 0;

    for (let i = 0; i < clusterBuffers.length; i++) {
      const buffer = clusterBuffers[i];
      if ((i + 1) % 100 === 0 || i === 0) {
        Logger.log(
          `Querying cluster ${i + 1}/${clusterBuffers.length} (${totalCount} peaks so far)...`,
        );
      }
      const rows = await queryPeaksInBuffer(localPool, buffer.bufferGeoJSON);

      const batch: InputFeature[] = [];
      for (const row of rows) {
        if (seenIds.has(row.osmId)) {
          continue;
        }
        seenIds.add(row.osmId);
        batch.push({
          osm_id: row.osmId,
          osm_type: "node",
          geometry: row.geometry,
          properties: {
            type: "node",
            id: row.osmId,
            tags: row.tags,
          },
        });
      }

      if (batch.length > 0) {
        await dataStore.saveInputPeaks(batch);
        totalCount += batch.length;
      }
    }

    Logger.log(`Fetched ${totalCount} peaks from local OSM planet database.`);

    return totalCount;
  } finally {
    await localPool.end();
    await processingPool.end();
  }
}

interface PeakRow {
  osmId: number;
  geometry: GeoJSON.Geometry;
  tags: Record<string, string>;
}

async function queryPeaksInBuffer(
  localPool: Pool,
  bufferGeoJSON: GeoJSON.Geometry,
): Promise<PeakRow[]> {
  const result = await localPool.query(
    `SELECT n.node_id AS osm_id,
            ST_AsGeoJSON(ST_Transform(n.geom, 4326))::json AS geometry,
            hstore_to_json(n.tags) AS tags
     FROM public.nodes n
     WHERE ST_Intersects(
         n.geom,
         ST_Transform(ST_GeomFromGeoJSON($1), 3857)
       )
       AND n.tags ? 'natural'
       AND n.tags -> 'natural' IN ('peak', 'volcano')`,
    [JSON.stringify(bufferGeoJSON)],
  );

  return result.rows.map((row) => ({
    osmId: row.osm_id,
    geometry: row.geometry,
    tags: row.tags,
  }));
}
