/**
 * SQL constants for PostgreSQL Clustering Database
 */

export const SQL = {
  INSERT_OBJECT: `
    INSERT INTO objects
    (key, type, source, geometry, geometry_with_elevations, geom, is_polygon, activities, ski_areas,
     is_basis_for_new_ski_area, is_in_ski_area_polygon, is_in_ski_area_site,
     lift_type, difficulty, viirs_pixels, properties)
    VALUES ($1, $2, $3, $4, $5, ST_MakeValid(ST_Force2D(ST_GeomFromGeoJSON($6)), 'method=structure'), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (key) DO UPDATE SET
      type = EXCLUDED.type,
      source = EXCLUDED.source,
      geometry = EXCLUDED.geometry,
      geometry_with_elevations = EXCLUDED.geometry_with_elevations,
      geom = EXCLUDED.geom,
      is_polygon = EXCLUDED.is_polygon,
      activities = EXCLUDED.activities,
      ski_areas = EXCLUDED.ski_areas,
      is_basis_for_new_ski_area = EXCLUDED.is_basis_for_new_ski_area,
      is_in_ski_area_polygon = EXCLUDED.is_in_ski_area_polygon,
      is_in_ski_area_site = EXCLUDED.is_in_ski_area_site,
      lift_type = EXCLUDED.lift_type,
      difficulty = EXCLUDED.difficulty,
      viirs_pixels = EXCLUDED.viirs_pixels,
      properties = EXCLUDED.properties
  `,

  CREATE_OBJECTS_TABLE: `
    CREATE TABLE IF NOT EXISTS objects (
      key TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      geometry JSONB NOT NULL,
      geometry_with_elevations JSONB,
      is_polygon BOOLEAN NOT NULL,
      activities JSONB,
      ski_areas JSONB,
      is_basis_for_new_ski_area BOOLEAN DEFAULT FALSE,
      is_in_ski_area_polygon BOOLEAN DEFAULT FALSE,
      is_in_ski_area_site BOOLEAN DEFAULT FALSE,
      lift_type TEXT,
      difficulty TEXT,
      viirs_pixels JSONB,
      properties JSONB NOT NULL,
      geom GEOMETRY(Geometry, 4326)
    )
  `,

  CREATE_SPATIAL_INDEXES: `
    CREATE INDEX IF NOT EXISTS idx_objects_geom ON objects USING GIST (geom)
  `,

  CREATE_GEOGRAPHY_INDEX: `
    CREATE INDEX IF NOT EXISTS idx_objects_geog ON objects USING GIST (geography(geom))
  `,

  CREATE_COMPOSITE_INDEXES: `
    -- Core filtering indexes
    CREATE INDEX IF NOT EXISTS idx_type_source ON objects(type, source);
    CREATE INDEX IF NOT EXISTS idx_type_polygon ON objects(type, is_polygon);

    -- Ski area assignment queries
    CREATE INDEX IF NOT EXISTS idx_ski_areas_gin ON objects USING GIN (ski_areas);
    CREATE INDEX IF NOT EXISTS idx_type_ski_areas ON objects(type) WHERE ski_areas = '[]'::jsonb;

    -- Unassigned object queries (critical for clustering performance)
    CREATE INDEX IF NOT EXISTS idx_unassigned_runs ON objects(type, is_basis_for_new_ski_area)
      WHERE type = 'RUN' AND is_basis_for_new_ski_area = true;

    -- Source-specific queries with polygon filtering
    CREATE INDEX IF NOT EXISTS idx_source_polygon ON objects(source, is_polygon)
      WHERE is_polygon = true;
    CREATE INDEX IF NOT EXISTS idx_source_type_polygon ON objects(source, type, is_polygon);

    -- Activity-based filtering (using GIN for JSONB)
    CREATE INDEX IF NOT EXISTS idx_activities_gin ON objects USING GIN (activities);

    -- Polygon containment queries
    CREATE INDEX IF NOT EXISTS idx_polygon_filter ON objects(is_polygon, is_in_ski_area_polygon);
  `,

  DERIVED_GEOMETRY: `
    WITH member_geometries AS (
      SELECT geom FROM objects
      WHERE ski_areas @> $1::jsonb AND type != 'SKI_AREA'
    ),
    ski_area_geometry AS (
      SELECT geom FROM objects
      WHERE key = $2 AND type = 'SKI_AREA'
    ),
    union_result AS (
      SELECT
        CASE
          WHEN COUNT(*) > 0 THEN ST_AsGeoJSON(ST_Union(ST_MakeValid(geom, 'method=structure')))::jsonb
          ELSE NULL
        END as union_geometry
      FROM member_geometries
    )
    SELECT
      COALESCE(
        union_result.union_geometry,
        ST_AsGeoJSON(ski_area_geometry.geom)::jsonb
      ) as geometry
    FROM union_result
    CROSS JOIN ski_area_geometry
  `,
} as const;

/**
 * Batch size constants
 */
export const BATCH_SIZES = {
  DEFAULT: 1000,
  BULK_OPERATION: 5000,
} as const;
