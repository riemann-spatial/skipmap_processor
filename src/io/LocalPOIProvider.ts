import { Pool } from "pg";
import { LocalOSMDatabaseConfig, PostgresConfig } from "../Config";
import { getPostgresPoolConfig } from "../utils/getPostgresPoolConfig";
import { Logger } from "../utils/Logger";
import { computeClusterBuffers } from "./LocalOSMClusterBuffers";
import { InputFeature, PostGISDataStore } from "./PostGISDataStore";

const POI_TAG_FILTER = `
  (
    (tags ? 'amenity' AND tags -> 'amenity' IN ('parking', 'restaurant', 'cafe', 'toilets', 'first_aid', 'ski_rental'))
    OR (tags ? 'shop' AND tags -> 'shop' = 'ski')
    OR (tags ? 'tourism' AND tags -> 'tourism' = 'alpine_hut')
  )
`;

export async function fetchPOIsFromLocalDB(
  processingDbConfig: PostgresConfig,
  localDbConfig: LocalOSMDatabaseConfig,
  dataStore: PostGISDataStore,
  bufferMeters?: number,
): Promise<{ facilitiesCount: number; alpineHutsCount: number }> {
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
      "Computing buffered envelopes around ski feature clusters for local POI query...",
    );
    const clusterBuffers = await computeClusterBuffers(
      processingPool,
      bufferMeters,
    );
    Logger.log(`Found ${clusterBuffers.length} ski feature cluster(s).`);

    if (clusterBuffers.length === 0) {
      Logger.log("No ski features found, skipping local POI query.");
      return { facilitiesCount: 0, alpineHutsCount: 0 };
    }

    Logger.log("Querying POIs from local OSM planet database...");
    const seenIds = new Set<string>();
    let facilitiesCount = 0;
    let alpineHutsCount = 0;

    for (let i = 0; i < clusterBuffers.length; i++) {
      const buffer = clusterBuffers[i];
      if ((i + 1) % 100 === 0 || i === 0) {
        Logger.log(
          `Querying cluster ${i + 1}/${clusterBuffers.length} (${facilitiesCount} facilities, ${alpineHutsCount} alpine huts so far)...`,
        );
      }

      const rows = await queryPOIsInBuffer(localPool, buffer.bufferGeoJSON);

      const facilityBatch: InputFeature[] = [];
      const alpineHutBatch: InputFeature[] = [];

      for (const row of rows) {
        const key = `${row.osmType}/${row.osmId}`;
        if (seenIds.has(key)) {
          continue;
        }
        seenIds.add(key);

        const feature: InputFeature = {
          osm_id: row.osmId,
          osm_type: row.osmType,
          geometry: row.geometry,
          properties: {
            type: row.osmType,
            id: row.osmId,
            tags: row.tags,
          },
        };

        if (row.tags.tourism === "alpine_hut") {
          alpineHutBatch.push(feature);
        } else {
          facilityBatch.push(feature);
        }
      }

      if (facilityBatch.length > 0) {
        await dataStore.saveInputFacilities(facilityBatch);
        facilitiesCount += facilityBatch.length;
      }
      if (alpineHutBatch.length > 0) {
        await dataStore.saveInputAlpineHuts(alpineHutBatch);
        alpineHutsCount += alpineHutBatch.length;
      }
    }

    Logger.log(
      `Fetched ${facilitiesCount} facilities and ${alpineHutsCount} alpine huts from local OSM planet database.`,
    );

    return { facilitiesCount, alpineHutsCount };
  } finally {
    await localPool.end();
    await processingPool.end();
  }
}

interface POIRow {
  osmId: number;
  osmType: string;
  geometry: GeoJSON.Geometry;
  tags: Record<string, string>;
}

async function queryPOIsInBuffer(
  localPool: Pool,
  bufferGeoJSON: GeoJSON.Geometry,
): Promise<POIRow[]> {
  const bufferParam = JSON.stringify(bufferGeoJSON);

  // Query nodes
  const nodesResult = await localPool.query(
    `SELECT n.node_id AS osm_id,
            'node' AS osm_type,
            ST_AsGeoJSON(ST_Transform(n.geom, 4326))::json AS geometry,
            hstore_to_json(n.tags) AS tags
     FROM public.nodes n
     WHERE ST_Intersects(
         n.geom,
         ST_Transform(ST_GeomFromGeoJSON($1), 3857)
       )
       AND ${POI_TAG_FILTER.replace(/tags/g, "n.tags")}`,
    [bufferParam],
  );

  // Query ways
  const waysResult = await localPool.query(
    `SELECT w.way_id AS osm_id,
            'way' AS osm_type,
            ST_AsGeoJSON(ST_Transform(
              CASE
                WHEN ST_IsClosed(w.geom) AND ST_NPoints(w.geom) >= 4
                  THEN COALESCE(ST_BuildArea(w.geom), w.geom)
                ELSE w.geom
              END,
              4326
            ))::json AS geometry,
            hstore_to_json(w.tags) AS tags
     FROM public.ways w
     WHERE w.geom && ST_Transform(ST_GeomFromGeoJSON($1), 3857)
       AND ${POI_TAG_FILTER.replace(/tags/g, "w.tags")}`,
    [bufferParam],
  );

  // Query relations (build geometry from member ways)
  const relationsResult = await localPool.query(
    `SELECT r.relation_id AS osm_id,
            'relation' AS osm_type,
            ST_AsGeoJSON(ST_Transform(
              ST_Collect(
                CASE
                  WHEN ST_IsClosed(w.geom) AND ST_NPoints(w.geom) >= 4
                    THEN COALESCE(ST_BuildArea(w.geom), w.geom)
                  ELSE w.geom
                END
              ),
              4326
            ))::json AS geometry,
            hstore_to_json(r.tags) AS tags
     FROM public.relations r
     CROSS JOIN LATERAL jsonb_array_elements(r.members) AS m
     JOIN public.ways w ON w.way_id = (m->>'ref')::bigint AND m->>'type' = 'w'
     WHERE jsonb_typeof(r.members) = 'array'
       AND w.geom && ST_Transform(ST_GeomFromGeoJSON($1), 3857)
       AND ${POI_TAG_FILTER.replace(/tags/g, "r.tags")}
     GROUP BY r.relation_id, r.tags`,
    [bufferParam],
  );

  const rows: POIRow[] = [];
  for (const result of [nodesResult, waysResult, relationsResult]) {
    for (const row of result.rows) {
      if (row.geometry) {
        rows.push({
          osmId: row.osm_id,
          osmType: row.osm_type,
          geometry: row.geometry,
          tags: row.tags,
        });
      }
    }
  }

  return rows;
}
