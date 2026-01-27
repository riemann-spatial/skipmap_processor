#!/bin/bash

# Startup script for openskidata-processor
# Starts PostgreSQL in the background and waits for it to be ready,
# then runs the processing pipeline.

set -e

echo "=== OpenSkiData Processor Startup ==="

# Start PostgreSQL initialization in background
echo "Starting PostgreSQL..."
/usr/local/bin/init-postgres.sh &
POSTGRES_PID=$!

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if pg_isready -h localhost -p 5432 -U "${POSTGRES_USER:-postgres}" > /dev/null 2>&1; then
        echo "PostgreSQL is ready!"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "Waiting for PostgreSQL... (attempt $RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "ERROR: PostgreSQL failed to start within the timeout period"
    exit 1
fi

# Check if COMPILE_NEW is set to false (case-insensitive)
COMPILE_NEW_LOWER=$(echo "${COMPILE_NEW:-true}" | tr '[:upper:]' '[:lower:]')

if [ "$COMPILE_NEW_LOWER" = "false" ] || [ "$COMPILE_NEW_LOWER" = "0" ]; then
    echo "COMPILE_NEW is false - skipping data compilation, PostgreSQL is running."
    echo "Connect to PostgreSQL at localhost:5432 (or mapped port from host)"
else
    # Ensure database schema is up-to-date (creates missing tables)
    echo "Ensuring database schema is up-to-date..."
    PGPASSWORD="${POSTGRES_PASSWORD}" psql -h localhost -U "${POSTGRES_USER:-postgres}" -d openskidata << 'EOSQL'
-- Ensure schemas exist
CREATE SCHEMA IF NOT EXISTS input;
CREATE SCHEMA IF NOT EXISTS output;

-- input.runs
CREATE TABLE IF NOT EXISTS input.runs (
  id SERIAL PRIMARY KEY,
  osm_id BIGINT,
  osm_type TEXT,
  geometry GEOMETRY(Geometry, 4326),
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS runs_geometry_idx ON input.runs USING GIST (geometry);
CREATE INDEX IF NOT EXISTS runs_osm_id_idx ON input.runs (osm_id);

-- input.lifts
CREATE TABLE IF NOT EXISTS input.lifts (
  id SERIAL PRIMARY KEY,
  osm_id BIGINT,
  osm_type TEXT,
  geometry GEOMETRY(Geometry, 4326),
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lifts_geometry_idx ON input.lifts USING GIST (geometry);
CREATE INDEX IF NOT EXISTS lifts_osm_id_idx ON input.lifts (osm_id);

-- input.ski_areas
CREATE TABLE IF NOT EXISTS input.ski_areas (
  id SERIAL PRIMARY KEY,
  osm_id BIGINT,
  osm_type TEXT,
  geometry GEOMETRY(Geometry, 4326),
  properties JSONB,
  source TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ski_areas_input_geometry_idx ON input.ski_areas USING GIST (geometry);
CREATE INDEX IF NOT EXISTS ski_areas_input_osm_id_idx ON input.ski_areas (osm_id);
CREATE INDEX IF NOT EXISTS ski_areas_input_source_idx ON input.ski_areas (source);

-- input.ski_area_sites
CREATE TABLE IF NOT EXISTS input.ski_area_sites (
  id SERIAL PRIMARY KEY,
  osm_id BIGINT,
  properties JSONB,
  member_ids JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ski_area_sites_osm_id_idx ON input.ski_area_sites (osm_id);

-- input.highways
CREATE TABLE IF NOT EXISTS input.highways (
  id SERIAL PRIMARY KEY,
  osm_id BIGINT,
  osm_type TEXT,
  geometry GEOMETRY(Geometry, 4326),
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS highways_input_geometry_idx ON input.highways USING GIST (geometry);
CREATE INDEX IF NOT EXISTS highways_input_osm_id_idx ON input.highways (osm_id);

-- output.runs
CREATE TABLE IF NOT EXISTS output.runs (
  id SERIAL PRIMARY KEY,
  feature_id TEXT UNIQUE NOT NULL,
  geometry GEOMETRY(GeometryZ, 4326),
  type TEXT,
  name TEXT,
  ref TEXT,
  description TEXT,
  uses TEXT[],
  difficulty TEXT,
  difficulty_convention TEXT,
  oneway BOOLEAN,
  gladed BOOLEAN,
  patrolled BOOLEAN,
  lit BOOLEAN,
  grooming TEXT,
  status TEXT,
  websites TEXT[],
  wikidata_id TEXT,
  ski_areas JSONB,
  sources JSONB,
  places JSONB,
  elevation_profile JSONB,
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS runs_output_geometry_idx ON output.runs USING GIST (geometry);
CREATE INDEX IF NOT EXISTS runs_output_feature_id_idx ON output.runs (feature_id);
CREATE INDEX IF NOT EXISTS runs_output_difficulty_idx ON output.runs (difficulty);
CREATE INDEX IF NOT EXISTS runs_output_status_idx ON output.runs (status);
CREATE INDEX IF NOT EXISTS runs_output_name_idx ON output.runs (name);

-- output.lifts
CREATE TABLE IF NOT EXISTS output.lifts (
  id SERIAL PRIMARY KEY,
  feature_id TEXT UNIQUE NOT NULL,
  geometry GEOMETRY(GeometryZ, 4326),
  type TEXT,
  name TEXT,
  ref TEXT,
  ref_fr_cairn TEXT,
  description TEXT,
  lift_type TEXT,
  status TEXT,
  oneway BOOLEAN,
  occupancy INTEGER,
  capacity INTEGER,
  duration INTEGER,
  bubble BOOLEAN,
  heating BOOLEAN,
  detachable BOOLEAN,
  websites TEXT[],
  wikidata_id TEXT,
  ski_areas JSONB,
  sources JSONB,
  places JSONB,
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lifts_output_geometry_idx ON output.lifts USING GIST (geometry);
CREATE INDEX IF NOT EXISTS lifts_output_feature_id_idx ON output.lifts (feature_id);
CREATE INDEX IF NOT EXISTS lifts_output_lift_type_idx ON output.lifts (lift_type);
CREATE INDEX IF NOT EXISTS lifts_output_status_idx ON output.lifts (status);
CREATE INDEX IF NOT EXISTS lifts_output_name_idx ON output.lifts (name);

-- output.ski_areas
CREATE TABLE IF NOT EXISTS output.ski_areas (
  id SERIAL PRIMARY KEY,
  feature_id TEXT UNIQUE NOT NULL,
  geometry GEOMETRY(GeometryZ, 4326),
  type TEXT,
  name TEXT,
  status TEXT,
  activities TEXT[],
  run_convention TEXT,
  websites TEXT[],
  wikidata_id TEXT,
  sources JSONB,
  places JSONB,
  statistics JSONB,
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ski_areas_output_geometry_idx ON output.ski_areas USING GIST (geometry);
CREATE INDEX IF NOT EXISTS ski_areas_output_feature_id_idx ON output.ski_areas (feature_id);
CREATE INDEX IF NOT EXISTS ski_areas_output_status_idx ON output.ski_areas (status);
CREATE INDEX IF NOT EXISTS ski_areas_output_name_idx ON output.ski_areas (name);
CREATE INDEX IF NOT EXISTS ski_areas_output_activities_idx ON output.ski_areas USING GIN (activities);

-- output.highways
CREATE TABLE IF NOT EXISTS output.highways (
  id SERIAL PRIMARY KEY,
  feature_id TEXT UNIQUE NOT NULL,
  geometry GEOMETRY(GeometryZ, 4326),
  type TEXT,
  name TEXT,
  ref TEXT,
  highway_type TEXT,
  is_road BOOLEAN,
  is_walkway BOOLEAN,
  is_private BOOLEAN,
  surface TEXT,
  smoothness TEXT,
  lit BOOLEAN,
  status TEXT,
  websites TEXT[],
  wikidata_id TEXT,
  ski_areas JSONB,
  sources JSONB,
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS highways_output_geometry_idx ON output.highways USING GIST (geometry);
CREATE INDEX IF NOT EXISTS highways_output_feature_id_idx ON output.highways (feature_id);
CREATE INDEX IF NOT EXISTS highways_output_highway_type_idx ON output.highways (highway_type);
CREATE INDEX IF NOT EXISTS highways_output_status_idx ON output.highways (status);
CREATE INDEX IF NOT EXISTS highways_output_name_idx ON output.highways (name);
CREATE INDEX IF NOT EXISTS highways_output_is_road_idx ON output.highways (is_road);
CREATE INDEX IF NOT EXISTS highways_output_is_walkway_idx ON output.highways (is_walkway);

-- objects (clustering working table)
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
);
CREATE INDEX IF NOT EXISTS idx_objects_geom ON objects USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_objects_geog ON objects USING GIST (geography(geom));
CREATE INDEX IF NOT EXISTS idx_type_source ON objects(type, source);
CREATE INDEX IF NOT EXISTS idx_type_polygon ON objects(type, is_polygon);
CREATE INDEX IF NOT EXISTS idx_ski_areas_gin ON objects USING GIN (ski_areas);
CREATE INDEX IF NOT EXISTS idx_activities_gin ON objects USING GIN (activities);
EOSQL
    echo "Database schema is up-to-date."

    # Install npm dependencies if needed
    if [ ! -d "node_modules" ] || [ ! -f "node_modules/.package-lock.json" ]; then
        echo "Installing npm dependencies..."
        npm install
    fi

    # Run the processing pipeline
    echo "Starting OpenSkiData processing..."
    ./run.sh

    echo "Processing complete!"
fi

# Keep the container running by waiting for PostgreSQL
wait $POSTGRES_PID
