import { Pool } from "pg";
import { LocalOSMDatabaseConfig, PostgresConfig } from "../Config";
import { getPostgresPoolConfig } from "../utils/getPostgresPoolConfig";
import { Logger } from "../utils/Logger";
import { ClusterBuffer, computeClusterBuffers } from "./LocalOSMClusterBuffers";
import { InputFeature, PostGISDataStore } from "./PostGISDataStore";

// Clusters wider or taller than this (in degrees) are split into a grid of tiles
const MAX_TILE_DEGREES = 0.5;

export async function fetchHighwaysFromLocalDB(
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
    // Step 1: Compute buffered envelopes around clusters of ski features
    Logger.log(
      "Computing buffered envelopes around ski feature clusters for local highway query...",
    );
    const clusterBuffers = await computeClusterBuffers(
      processingPool,
      bufferMeters,
    );
    Logger.log(`Found ${clusterBuffers.length} ski feature cluster(s).`);

    if (clusterBuffers.length === 0) {
      Logger.log("No ski features found, skipping local highway query.");
      return 0;
    }

    // Split large clusters into smaller tiles
    const clusterTiles = splitClustersIntoTiles(clusterBuffers);
    Logger.log(
      `Split ${clusterBuffers.length} cluster(s) into ${clusterTiles.length} tile(s).`,
    );

    // Also include tiles for ski area polygon interiors so all highways
    // inside a ski area are captured regardless of cluster buffer distance
    const skiAreaTiles = await getSkiAreaPolygonTiles(processingPool);
    Logger.log(
      `Added ${skiAreaTiles.length} tile(s) from ski area polygon interiors.`,
    );

    const tiles = [...clusterTiles, ...skiAreaTiles];

    // Step 2: Get existing run/lift osm_ids to exclude duplicates
    const existingOsmIds = await getExistingSkiFeatureIds(processingPool);
    Logger.log(
      `Found ${existingOsmIds.size} existing run/lift OSM IDs to exclude.`,
    );

    // Step 3: Query highways from local planet DB per tile, saving as we go
    Logger.log("Querying highways from local OSM planet database...");
    const seenIds = new Set<number>();
    let totalCount = 0;

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      if ((i + 1) % 100 === 0 || i === 0) {
        Logger.log(
          `Querying tile ${i + 1}/${tiles.length} (${totalCount} highways so far)...`,
        );
      }
      const rows = await queryHighwaysInBBox(localPool, tile);

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
      `Fetched ${totalCount} candidate highways from local OSM planet database.`,
    );

    // Step 4: Precise filter — remove highways that don't actually intersect
    // a cluster buffer polygon or a ski area polygon. The bbox tile query
    // over-selects because it includes rectangular gaps between features.
    const removedCount = await preciseFilterHighways(
      processingPool,
      bufferMeters,
    );
    const finalCount = totalCount - removedCount;
    Logger.log(
      `Precise filter: removed ${removedCount} highways outside ski features, ${finalCount} remaining.`,
    );

    return finalCount;
  } finally {
    await localPool.end();
    await processingPool.end();
  }
}

interface BBoxTile {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

function splitClustersIntoTiles(clusters: ClusterBuffer[]): BBoxTile[] {
  const tiles: BBoxTile[] = [];

  for (const cluster of clusters) {
    const bbox = computeBBox(cluster.bufferGeoJSON);
    if (!bbox) {
      continue;
    }

    const width = bbox.maxLon - bbox.minLon;
    const height = bbox.maxLat - bbox.minLat;

    if (width <= MAX_TILE_DEGREES && height <= MAX_TILE_DEGREES) {
      tiles.push(bbox);
    } else {
      const cols = Math.ceil(width / MAX_TILE_DEGREES);
      const rows = Math.ceil(height / MAX_TILE_DEGREES);
      const tileWidth = width / cols;
      const tileHeight = height / rows;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          tiles.push({
            minLon: bbox.minLon + col * tileWidth,
            minLat: bbox.minLat + row * tileHeight,
            maxLon: bbox.minLon + (col + 1) * tileWidth,
            maxLat: bbox.minLat + (row + 1) * tileHeight,
          });
        }
      }

      Logger.log(
        `Split cluster ${cluster.clusterId} (${width.toFixed(1)}° x ${height.toFixed(1)}°) into ${cols * rows} tiles`,
      );
    }
  }

  return tiles;
}

function computeBBox(geometry: GeoJSON.Geometry): BBoxTile | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const coords = extractCoordinates(geometry);
  if (coords.length === 0) {
    return null;
  }

  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }

  return { minLon, minLat, maxLon, maxLat };
}

function extractCoordinates(geometry: GeoJSON.Geometry): number[][] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
    case "GeometryCollection":
      return geometry.geometries.flatMap(extractCoordinates);
    default:
      return [];
  }
}

async function preciseFilterHighways(
  processingPool: Pool,
  bufferMeters: number = 1000,
): Promise<number> {
  // Build a filter geometry: union of cluster buffers + ski area polygons
  // Use a temp table with GiST index for efficient spatial join
  await processingPool.query(`
    CREATE TEMP TABLE IF NOT EXISTS temp_highway_filter (
      geom GEOMETRY(Geometry, 4326)
    )
  `);
  await processingPool.query("TRUNCATE temp_highway_filter");

  // Insert cluster buffer polygons (already decomposed by ST_Dump)
  await processingPool.query(
    `
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
    buffered AS (
      SELECT ST_Transform(
               ST_Buffer(ST_Transform(geometry, 3857), $1),
               4326
             ) AS geom
      FROM valid_features
    )
    INSERT INTO temp_highway_filter (geom)
    SELECT geom FROM buffered
  `,
    [bufferMeters],
  );

  // Also insert ski area polygons (highways inside a ski area are always kept)
  await processingPool.query(`
    INSERT INTO temp_highway_filter (geom)
    SELECT geometry FROM input.ski_areas
    WHERE ST_GeometryType(geometry) IN ('ST_Polygon', 'ST_MultiPolygon')
  `);

  await processingPool.query(
    "CREATE INDEX IF NOT EXISTS idx_temp_highway_filter_geom ON temp_highway_filter USING GIST (geom)",
  );
  await processingPool.query("ANALYZE temp_highway_filter");

  // Delete highways that don't intersect any filter geometry
  const result = await processingPool.query(`
    DELETE FROM input.highways h
    WHERE NOT EXISTS (
      SELECT 1 FROM temp_highway_filter f
      WHERE ST_Intersects(h.geometry, f.geom)
    )
  `);

  await processingPool.query("DROP TABLE IF EXISTS temp_highway_filter");

  return result.rowCount ?? 0;
}

async function getSkiAreaPolygonTiles(
  processingPool: Pool,
): Promise<BBoxTile[]> {
  const result = await processingPool.query(`
    SELECT
      ST_XMin(geometry) AS min_lon,
      ST_YMin(geometry) AS min_lat,
      ST_XMax(geometry) AS max_lon,
      ST_YMax(geometry) AS max_lat
    FROM input.ski_areas
    WHERE ST_GeometryType(geometry) IN ('ST_Polygon', 'ST_MultiPolygon')
  `);

  const bboxes: BBoxTile[] = result.rows.map((row) => ({
    minLon: row.min_lon,
    minLat: row.min_lat,
    maxLon: row.max_lon,
    maxLat: row.max_lat,
  }));

  // Split large ski area bboxes into tiles too
  const tiles: BBoxTile[] = [];
  for (const bbox of bboxes) {
    const width = bbox.maxLon - bbox.minLon;
    const height = bbox.maxLat - bbox.minLat;

    if (width <= MAX_TILE_DEGREES && height <= MAX_TILE_DEGREES) {
      tiles.push(bbox);
    } else {
      const cols = Math.ceil(width / MAX_TILE_DEGREES);
      const rows = Math.ceil(height / MAX_TILE_DEGREES);
      const tileWidth = width / cols;
      const tileHeight = height / rows;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          tiles.push({
            minLon: bbox.minLon + col * tileWidth,
            minLat: bbox.minLat + row * tileHeight,
            maxLon: bbox.minLon + (col + 1) * tileWidth,
            maxLat: bbox.minLat + (row + 1) * tileHeight,
          });
        }
      }
    }
  }

  return tiles;
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

async function queryHighwaysInBBox(
  localPool: Pool,
  tile: BBoxTile,
): Promise<HighwayRow[]> {
  const result = await localPool.query(
    `SELECT w.way_id AS osm_id,
            ST_AsGeoJSON(ST_Transform(w.geom, 4326))::json AS geometry,
            hstore_to_json(w.tags) AS tags
     FROM public.ways w
     WHERE w.geom && ST_Transform(
             ST_MakeEnvelope($1, $2, $3, $4, 4326),
             3857
           )
       AND w.tags ? 'highway'
       AND NOT (w.tags ? 'piste:type')
       AND NOT (w.tags ? 'aerialway')
       AND NOT (w.tags ? 'railway')
       AND w.tags -> 'highway' NOT IN ('proposed', 'construction', 'abandoned', 'disused')
       AND ST_GeometryType(w.geom) IN ('ST_LineString', 'ST_MultiLineString')`,
    [tile.minLon, tile.minLat, tile.maxLon, tile.maxLat],
  );

  return result.rows.map((row) => ({
    osmId: row.osm_id,
    geometry: row.geometry,
    tags: row.tags,
  }));
}
