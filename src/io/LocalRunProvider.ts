import { Pool } from "pg";
import { LocalOSMDatabaseConfig } from "../Config";
import { Logger } from "../utils/Logger";
import { buildBBoxFilter } from "./LocalOSMBBoxFilter";
import { InputFeature, PostGISDataStore } from "./PostGISDataStore";

export async function fetchRunsFromLocalDB(
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
    Logger.log("Querying runs from local OSM planet database...");
    const seenIds = new Set<string>();
    let totalCount = 0;

    // Query run ways
    const wayRows = await queryRunWays(localPool, bbox);
    const wayBatch: InputFeature[] = [];
    for (const row of wayRows) {
      const key = `way/${row.osmId}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      wayBatch.push({
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
    if (wayBatch.length > 0) {
      await dataStore.saveInputRuns(wayBatch);
      totalCount += wayBatch.length;
    }
    Logger.log(`Fetched ${wayBatch.length} run ways from local DB.`);

    // Query run relations
    const relationRows = await queryRunRelations(localPool);
    const relationBatch: InputFeature[] = [];
    for (const row of relationRows) {
      const key = `relation/${row.osmId}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      relationBatch.push({
        osm_id: row.osmId,
        osm_type: "relation",
        geometry: row.geometry,
        properties: {
          type: "relation",
          id: row.osmId,
          tags: row.tags,
        },
      });
    }
    if (relationBatch.length > 0) {
      await dataStore.saveInputRuns(relationBatch);
      totalCount += relationBatch.length;
    }
    Logger.log(`Fetched ${relationBatch.length} run relations from local DB.`);

    Logger.log(
      `Fetched ${totalCount} runs total from local OSM planet database.`,
    );
    return totalCount;
  } finally {
    await localPool.end();
  }
}

interface RunRow {
  osmId: number;
  geometry: GeoJSON.Geometry;
  tags: Record<string, string>;
}

async function queryRunWays(
  localPool: Pool,
  bbox: GeoJSON.BBox | null,
): Promise<RunRow[]> {
  const bboxFilter = buildBBoxFilter(bbox, "w.geom", 1);
  const result = await localPool.query(
    `SELECT w.way_id AS osm_id,
            ST_AsGeoJSON(ST_Transform(w.geom, 4326))::json AS geometry,
            hstore_to_json(w.tags) AS tags
     FROM public.ways w
     WHERE w.tags ? 'piste:type'
       AND ${bboxFilter.clause}`,
    bboxFilter.params,
  );

  return result.rows.map((row) => ({
    osmId: row.osm_id,
    geometry: row.geometry,
    tags: row.tags,
  }));
}

async function queryRunRelations(localPool: Pool): Promise<RunRow[]> {
  const result = await localPool.query(
    `SELECT r.relation_id AS osm_id,
            hstore_to_json(r.tags) AS tags,
            ST_AsGeoJSON(ST_Transform(
              CASE
                WHEN r.tags -> 'piste:type' = 'downhill'
                  THEN COALESCE(ST_BuildArea(ST_Union(w.geom)), ST_LineMerge(ST_Union(w.geom)))
                ELSE ST_LineMerge(ST_Union(w.geom))
              END,
              4326
            ))::json AS geometry
     FROM public.relations r
     CROSS JOIN LATERAL jsonb_array_elements(r.members) AS m
     JOIN public.ways w ON w.way_id = (m->>'ref')::bigint AND m->>'type' = 'way'
     WHERE r.tags ? 'piste:type'
     GROUP BY r.relation_id, r.tags
     HAVING ST_Union(w.geom) IS NOT NULL`,
  );

  return result.rows.map((row) => ({
    osmId: row.osm_id,
    geometry: row.geometry,
    tags: row.tags,
  }));
}
