import { Pool } from "pg";

export interface ClusterBuffer {
  clusterId: number;
  bufferGeoJSON: GeoJSON.Geometry;
}

const DEFAULT_BUFFER_METERS = 1000;

/**
 * Compute buffered envelopes around clusters of ski features.
 *
 * Features are grouped by ST_ClusterDBSCAN, buffered, dissolved, and then
 * decomposed with ST_Dump so each returned row is a single Polygon rather
 * than a potentially huge MultiPolygon spanning an entire mountain range.
 */
export async function computeClusterBuffers(
  processingPool: Pool,
  bufferMeters: number = DEFAULT_BUFFER_METERS,
): Promise<ClusterBuffer[]> {
  const result = await processingPool.query(
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
    clustered AS (
      SELECT geometry,
             ST_ClusterDBSCAN(geometry, eps := 0.05, minpoints := 1)
               OVER () AS cluster_id
      FROM valid_features
    ),
    cluster_unions AS (
      SELECT cluster_id,
             ST_Transform(
               ST_Union(ST_Buffer(ST_Transform(geometry, 3857), $1)),
               4326
             ) AS geom
      FROM clustered
      GROUP BY cluster_id
    )
    SELECT cluster_id,
           ST_AsGeoJSON((ST_Dump(geom)).geom)::json AS buffer_geojson
    FROM cluster_unions
  `,
    [bufferMeters],
  );

  return result.rows.map((row) => ({
    clusterId: row.cluster_id,
    bufferGeoJSON: row.buffer_geojson,
  }));
}
