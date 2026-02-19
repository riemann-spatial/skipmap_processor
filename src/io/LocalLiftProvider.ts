import { Pool } from "pg";
import { LocalOSMDatabaseConfig } from "../Config";
import { Logger } from "../utils/Logger";
import { buildBBoxFilter } from "./LocalOSMBBoxFilter";
import { InputFeature, PostGISDataStore } from "./PostGISDataStore";

export async function fetchLiftsFromLocalDB(
  localDbConfig: LocalOSMDatabaseConfig,
  dataStore: PostGISDataStore,
  bbox: GeoJSON.BBox | null,
): Promise<number> {
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
    Logger.log("Querying lifts from local OSM planet database...");
    const seenIds = new Set<number>();
    let totalCount = 0;

    // Query lift ways (aerialway, funicular, and status variants)
    const liftRows = await queryLiftWays(localPool, bbox);
    const batch: InputFeature[] = [];
    for (const row of liftRows) {
      if (seenIds.has(row.osmId)) continue;
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

    // Query site-railway ways (railway ways in site=piste relations)
    const siteRailwayRows = await querySiteRailwayWays(localPool, bbox);
    for (const row of siteRailwayRows) {
      if (seenIds.has(row.osmId)) continue;
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
      await dataStore.saveInputLifts(batch);
      totalCount = batch.length;
    }

    Logger.log(`Fetched ${totalCount} lifts from local OSM planet database.`);
    return totalCount;
  } finally {
    await localPool.end();
  }
}

interface LiftRow {
  osmId: number;
  geometry: GeoJSON.Geometry;
  tags: Record<string, string>;
}

async function queryLiftWays(
  localPool: Pool,
  bbox: GeoJSON.BBox | null,
): Promise<LiftRow[]> {
  const bboxFilter = buildBBoxFilter(bbox, "w.geom", 1);
  const result = await localPool.query(
    `SELECT w.way_id AS osm_id,
            ST_AsGeoJSON(ST_Transform(w.geom, 4326))::json AS geometry,
            hstore_to_json(w.tags) AS tags
     FROM public.ways w
     WHERE (w.tags ? 'aerialway'
         OR w.tags ? 'disused:aerialway'
         OR w.tags ? 'abandoned:aerialway'
         OR w.tags ? 'proposed:aerialway'
         OR w.tags ? 'planned:aerialway'
         OR w.tags ? 'construction:aerialway'
         OR w.tags -> 'railway' = 'funicular')
       AND ${bboxFilter.clause}`,
    bboxFilter.params,
  );

  return result.rows.map((row) => ({
    osmId: row.osm_id,
    geometry: row.geometry,
    tags: row.tags,
  }));
}

async function querySiteRailwayWays(
  localPool: Pool,
  bbox: GeoJSON.BBox | null,
): Promise<LiftRow[]> {
  const bboxFilter = buildBBoxFilter(bbox, "w.geom", 1);
  const result = await localPool.query(
    `SELECT w.way_id AS osm_id,
            ST_AsGeoJSON(ST_Transform(w.geom, 4326))::json AS geometry,
            hstore_to_json(w.tags) AS tags
     FROM public.relations r
     CROSS JOIN LATERAL jsonb_array_elements(r.members) AS m
     JOIN public.ways w ON w.way_id = (m->>'ref')::bigint AND m->>'type' = 'way'
     WHERE r.tags -> 'site' = 'piste'
       AND w.tags ? 'railway'
       AND ${bboxFilter.clause}`,
    bboxFilter.params,
  );

  return result.rows.map((row) => ({
    osmId: row.osm_id,
    geometry: row.geometry,
    tags: row.tags,
  }));
}
