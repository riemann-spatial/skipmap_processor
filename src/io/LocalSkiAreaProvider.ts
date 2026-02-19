import { Pool } from "pg";
import { LocalOSMDatabaseConfig } from "../Config";
import { Logger } from "../utils/Logger";
import { buildBBoxFilter } from "./LocalOSMBBoxFilter";
import {
  InputSkiAreaFeature,
  InputSkiAreaSite,
  PostGISDataStore,
} from "./PostGISDataStore";

export async function fetchSkiAreasFromLocalDB(
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
    Logger.log("Querying ski areas from local OSM planet database...");
    const seenIds = new Set<string>();
    let totalCount = 0;

    // Query ski area ways
    const wayRows = await querySkiAreaWays(localPool, bbox);
    const wayBatch: InputSkiAreaFeature[] = [];
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
        source: "openstreetmap",
      });
    }
    if (wayBatch.length > 0) {
      await dataStore.saveInputSkiAreas(wayBatch);
      totalCount += wayBatch.length;
    }
    Logger.log(`Fetched ${wayBatch.length} ski area ways from local DB.`);

    // Query ski area relations
    const relationRows = await querySkiAreaRelations(localPool);
    const relationBatch: InputSkiAreaFeature[] = [];
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
        source: "openstreetmap",
      });
    }
    if (relationBatch.length > 0) {
      await dataStore.saveInputSkiAreas(relationBatch);
      totalCount += relationBatch.length;
    }
    Logger.log(
      `Fetched ${relationBatch.length} ski area relations from local DB.`,
    );

    Logger.log(
      `Fetched ${totalCount} ski areas total from local OSM planet database.`,
    );
    return totalCount;
  } finally {
    await localPool.end();
  }
}

export async function fetchSkiAreaSitesFromLocalDB(
  localDbConfig: LocalOSMDatabaseConfig,
  dataStore: PostGISDataStore,
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
    Logger.log("Querying ski area sites from local OSM planet database...");

    const result = await localPool.query(
      `SELECT r.relation_id AS osm_id,
              hstore_to_json(r.tags) AS tags,
              r.members
       FROM public.relations r
       WHERE r.tags -> 'site' = 'piste'`,
    );

    const sites: InputSkiAreaSite[] = result.rows.map((row) => ({
      osm_id: row.osm_id,
      properties: row.tags || {},
      members: (row.members || [])
        .filter(
          (m: { type: string; ref: number }) =>
            m.type === "way" || m.type === "node",
        )
        .map((m: { type: string; ref: number }) => ({
          type: m.type,
          ref: m.ref,
        })),
    }));

    if (sites.length > 0) {
      await dataStore.saveInputSkiAreaSites(sites);
    }

    Logger.log(
      `Fetched ${sites.length} ski area sites from local OSM planet database.`,
    );
    return sites.length;
  } finally {
    await localPool.end();
  }
}

interface SkiAreaRow {
  osmId: number;
  geometry: GeoJSON.Geometry;
  tags: Record<string, string>;
}

const SKI_AREA_LANDUSE_FILTER = `(w.tags -> 'landuse' = 'winter_sports'
    OR w.tags -> 'disused:landuse' = 'winter_sports'
    OR w.tags -> 'abandoned:landuse' = 'winter_sports'
    OR w.tags -> 'proposed:landuse' = 'winter_sports'
    OR w.tags -> 'planned:landuse' = 'winter_sports'
    OR w.tags -> 'construction:landuse' = 'winter_sports')`;

const SKI_AREA_RELATION_LANDUSE_FILTER = `(r.tags -> 'landuse' = 'winter_sports'
    OR r.tags -> 'disused:landuse' = 'winter_sports'
    OR r.tags -> 'abandoned:landuse' = 'winter_sports'
    OR r.tags -> 'proposed:landuse' = 'winter_sports'
    OR r.tags -> 'planned:landuse' = 'winter_sports'
    OR r.tags -> 'construction:landuse' = 'winter_sports')`;

async function querySkiAreaWays(
  localPool: Pool,
  bbox: GeoJSON.BBox | null,
): Promise<SkiAreaRow[]> {
  const bboxFilter = buildBBoxFilter(bbox, "w.geom", 1);
  const result = await localPool.query(
    `SELECT w.way_id AS osm_id,
            ST_AsGeoJSON(ST_Transform(
              COALESCE(ST_BuildArea(w.geom), w.geom),
              4326
            ))::json AS geometry,
            hstore_to_json(w.tags) AS tags
     FROM public.ways w
     WHERE ${SKI_AREA_LANDUSE_FILTER}
       AND ${bboxFilter.clause}`,
    bboxFilter.params,
  );

  return result.rows.map((row) => ({
    osmId: row.osm_id,
    geometry: row.geometry,
    tags: row.tags,
  }));
}

async function querySkiAreaRelations(localPool: Pool): Promise<SkiAreaRow[]> {
  const result = await localPool.query(
    `SELECT r.relation_id AS osm_id,
            hstore_to_json(r.tags) AS tags,
            ST_AsGeoJSON(ST_Transform(
              COALESCE(ST_BuildArea(ST_Union(w.geom)), ST_Union(w.geom)),
              4326
            ))::json AS geometry
     FROM public.relations r
     CROSS JOIN LATERAL jsonb_array_elements(r.members) AS m
     JOIN public.ways w ON w.way_id = (m->>'ref')::bigint AND m->>'type' = 'way'
     WHERE ${SKI_AREA_RELATION_LANDUSE_FILTER}
     GROUP BY r.relation_id, r.tags
     HAVING ST_Union(w.geom) IS NOT NULL`,
  );

  return result.rows.map((row) => ({
    osmId: row.osm_id,
    geometry: row.geometry,
    tags: row.tags,
  }));
}
