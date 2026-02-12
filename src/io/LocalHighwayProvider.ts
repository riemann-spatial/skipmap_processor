import { Pool } from "pg";
import { LocalOSMDatabaseConfig, PostgresConfig } from "../Config";
import { getPostgresPoolConfig } from "../utils/getPostgresPoolConfig";
import { Logger } from "../utils/Logger";
import { InputFeature, PostGISDataStore } from "./PostGISDataStore";

export async function fetchHighwaysFromLocalDB(
  processingDbConfig: PostgresConfig,
  localDbConfig: LocalOSMDatabaseConfig,
  dataStore: PostGISDataStore,
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
    // Step 1: Compute buffered envelopes around clusters of ski features
    Logger.log(
      "Computing buffered envelopes around ski feature clusters for local highway query...",
    );
    const clusterBuffers = await computeClusterBuffers(processingPool);
    Logger.log(`Found ${clusterBuffers.length} ski feature cluster(s).`);

    if (clusterBuffers.length === 0) {
      Logger.log("No ski features found, skipping local highway query.");
      return 0;
    }

    // Step 2: Get existing run/lift osm_ids to exclude duplicates
    const existingOsmIds = await getExistingSkiFeatureIds(processingPool);
    Logger.log(
      `Found ${existingOsmIds.size} existing run/lift OSM IDs to exclude.`,
    );

    // Step 3: Query highways from local planet DB per cluster, saving as we go
    Logger.log("Querying highways from local OSM planet database...");
    const seenIds = new Set<number>();
    let totalCount = 0;

    for (let i = 0; i < clusterBuffers.length; i++) {
      const buffer = clusterBuffers[i];
      if ((i + 1) % 100 === 0 || i === 0) {
        Logger.log(
          `Querying cluster ${i + 1}/${clusterBuffers.length} (${totalCount} highways so far)...`,
        );
      }
      const rows = await queryHighwaysInBuffer(localPool, buffer.bufferGeoJSON);

      const batch: InputFeature[] = [];
      for (const row of rows) {
        if (seenIds.has(row.osmId) || existingOsmIds.has(row.osmId)) {
          continue;
        }
        seenIds.add(row.osmId);
        batch.push({
          osm_id: row.osmId,
          osm_type: "way",
          geometry: row.geometry,
          properties: {
            type: "way",
            id: row.osmId,
            tags: row.tags,
          },
        });
      }

      if (batch.length > 0) {
        await dataStore.saveInputHighways(batch);
        totalCount += batch.length;
      }
    }

    Logger.log(
      `Fetched ${totalCount} highways from local OSM planet database.`,
    );

    return totalCount;
  } finally {
    await localPool.end();
    await processingPool.end();
  }
}

interface ClusterBuffer {
  clusterId: number;
  bufferGeoJSON: GeoJSON.Geometry;
}

async function computeClusterBuffers(
  processingPool: Pool,
): Promise<ClusterBuffer[]> {
  const result = await processingPool.query(`
    WITH all_features AS (
      SELECT ST_MakeValid(geometry) AS geometry FROM input.runs
      UNION ALL
      SELECT ST_MakeValid(geometry) AS geometry FROM input.lifts
      UNION ALL
      SELECT ST_MakeValid(geometry) AS geometry FROM input.ski_areas
    ),
    valid_features AS (
      SELECT geometry FROM all_features WHERE NOT ST_IsEmpty(geometry)
    ),
    clustered AS (
      SELECT geometry,
             ST_ClusterDBSCAN(geometry, eps := 0.05, minpoints := 1)
               OVER () AS cluster_id
      FROM valid_features
    )
    SELECT cluster_id,
           ST_AsGeoJSON(
             ST_Transform(
               ST_Union(ST_Buffer(ST_Transform(geometry, 3857), 1000)),
               4326
             )
           )::json AS buffer_geojson
    FROM clustered
    GROUP BY cluster_id
  `);

  return result.rows.map((row) => ({
    clusterId: row.cluster_id,
    bufferGeoJSON: row.buffer_geojson,
  }));
}

async function getExistingSkiFeatureIds(
  processingPool: Pool,
): Promise<Set<number>> {
  const result = await processingPool.query(`
    SELECT osm_id FROM input.runs
    UNION
    SELECT osm_id FROM input.lifts
  `);
  return new Set(result.rows.map((row) => row.osm_id));
}

interface HighwayRow {
  osmId: number;
  geometry: GeoJSON.Geometry;
  tags: Record<string, string>;
}

async function queryHighwaysInBuffer(
  localPool: Pool,
  bufferGeoJSON: GeoJSON.Geometry,
): Promise<HighwayRow[]> {
  const result = await localPool.query(
    `SELECT w.way_id AS osm_id,
            ST_AsGeoJSON(ST_Transform(w.geom, 4326))::json AS geometry,
            hstore_to_json(w.tags) AS tags
     FROM public.ways w
     WHERE ST_Intersects(
         w.geom,
         ST_Transform(ST_GeomFromGeoJSON($1), 3857)
       )
       AND w.tags ? 'highway'
       AND NOT (w.tags ? 'piste:type')
       AND NOT (w.tags ? 'aerialway')
       AND NOT (w.tags ? 'railway')
       AND w.tags -> 'highway' NOT IN ('proposed', 'construction', 'abandoned', 'disused')
       AND ST_GeometryType(w.geom) IN ('ST_LineString', 'ST_MultiLineString')`,
    [JSON.stringify(bufferGeoJSON)],
  );

  return result.rows.map((row) => ({
    osmId: row.osm_id,
    geometry: row.geometry,
    tags: row.tags,
  }));
}
