#!/bin/bash

# PostgreSQL initialization script for openskidata-processor

set -e

echo "Starting PostgreSQL initialization..."

# Ensure the expected data directory exists (it is a bind mount in docker-compose,
# but for plain `docker run` it must be created inside the image/container).
DATA_DIR="/var/lib/postgresql/data"
mkdir -p "$DATA_DIR"
chown -R postgres:postgres "$DATA_DIR"
chmod 700 "$DATA_DIR"

# Configure PostgreSQL to listen on all addresses
echo "Configuring PostgreSQL to listen on all addresses..."
# Needs to be done each time as the data dir doesnt hold this file
sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" /etc/postgresql/15/main/postgresql.conf

# Configure authentication based on whether custom user/password are set
if [ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_PASSWORD" ]; then
    echo "Configuring PostgreSQL with password authentication..."
    # Needs to be done each time as the data dir doesnt hold this file
    tee "/etc/postgresql/15/main/pg_hba.conf" > /dev/null << EOF
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     trust
host    all             all             127.0.0.1/32            md5
host    all             all             ::1/128                 md5
host    all             all             0.0.0.0/0               md5
EOF
else
    echo "Configuring PostgreSQL with trust authentication..."
    tee "/etc/postgresql/15/main/pg_hba.conf" > /dev/null << EOF
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
host    all             all             0.0.0.0/0               trust
EOF
fi

# Update PostgreSQL config to use the data directory
sed -i "s|data_directory = '/var/lib/postgresql/15/main'|data_directory = '/var/lib/postgresql/data'|" /etc/postgresql/15/main/postgresql.conf

# Initialize PostgreSQL if not already initialized
if [ ! -f "$DATA_DIR/PG_VERSION" ]; then
    echo "Initializing PostgreSQL database..."
    echo "Setting up data directory permissions..."
    chown -R postgres:postgres "$DATA_DIR"
    chmod 700 "$DATA_DIR"
    su - postgres -c "/usr/lib/postgresql/15/bin/initdb -D $DATA_DIR"

    # Start PostgreSQL temporarily to create user if needed
    su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D $DATA_DIR -l /var/log/postgresql/postgresql-15-main.log start"
    
    # Wait for PostgreSQL to start
    sleep 5
    
    # Create custom user if environment variables are set
    if [ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_PASSWORD" ]; then
        echo "Creating custom user: $POSTGRES_USER"
        su - postgres -c "psql -c \"CREATE USER $POSTGRES_USER WITH PASSWORD '$POSTGRES_PASSWORD' SUPERUSER;\""
    fi

    # Create application databases
    echo "Creating application databases..."
    su - postgres -c "psql -c \"CREATE DATABASE openskidata_cache;\""
    su - postgres -c "psql -c \"CREATE DATABASE openskidata_test;\""
    su - postgres -c "psql -c \"CREATE DATABASE openskidata;\""

    # Enable PostGIS extension on all databases
    echo "Enabling PostGIS extensions..."
    su - postgres -c "psql -c \"CREATE EXTENSION IF NOT EXISTS postgis;\" openskidata_cache"
    su - postgres -c "psql -c \"CREATE EXTENSION IF NOT EXISTS postgis;\" openskidata_test"
    su - postgres -c "psql -c \"CREATE EXTENSION IF NOT EXISTS postgis;\" openskidata"

    # Create schemas and tables in openskidata database
    echo "Creating schemas and tables in openskidata database..."
    su - postgres -c "psql -d openskidata" << EOSQL
-- Create schemas with proper authorization
CREATE SCHEMA IF NOT EXISTS input AUTHORIZATION ${POSTGRES_USER:-postgres};
CREATE SCHEMA IF NOT EXISTS output AUTHORIZATION ${POSTGRES_USER:-postgres};

-- Grant usage on schemas
GRANT ALL ON SCHEMA input TO ${POSTGRES_USER:-postgres};
GRANT ALL ON SCHEMA output TO ${POSTGRES_USER:-postgres};
GRANT ALL ON SCHEMA public TO ${POSTGRES_USER:-postgres};

-- ============================================
-- INPUT SCHEMA: Raw data from Overpass/Skimap
-- ============================================

-- input.runs: Raw run features from Overpass
CREATE TABLE input.runs (
  id SERIAL PRIMARY KEY,
  osm_id BIGINT,
  osm_type TEXT,
  geometry GEOMETRY(Geometry, 4326),
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX runs_geometry_idx ON input.runs USING GIST (geometry);
CREATE INDEX runs_osm_id_idx ON input.runs (osm_id);

-- input.lifts: Raw lift features from Overpass
CREATE TABLE input.lifts (
  id SERIAL PRIMARY KEY,
  osm_id BIGINT,
  osm_type TEXT,
  geometry GEOMETRY(Geometry, 4326),
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX lifts_geometry_idx ON input.lifts USING GIST (geometry);
CREATE INDEX lifts_osm_id_idx ON input.lifts (osm_id);

-- input.ski_areas: Raw ski area features from Overpass/Skimap
CREATE TABLE input.ski_areas (
  id SERIAL PRIMARY KEY,
  osm_id BIGINT,
  osm_type TEXT,
  geometry GEOMETRY(Geometry, 4326),
  properties JSONB,
  source TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX ski_areas_input_geometry_idx ON input.ski_areas USING GIST (geometry);
CREATE INDEX ski_areas_input_osm_id_idx ON input.ski_areas (osm_id);
CREATE INDEX ski_areas_input_source_idx ON input.ski_areas (source);

-- input.ski_area_sites: Site relations from Overpass
CREATE TABLE input.ski_area_sites (
  id SERIAL PRIMARY KEY,
  osm_id BIGINT,
  properties JSONB,
  member_ids JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX ski_area_sites_osm_id_idx ON input.ski_area_sites (osm_id);

-- ============================================
-- OUTPUT SCHEMA: Processed/clustered features
-- ============================================

-- output.runs: Processed run features with exploded properties
CREATE TABLE output.runs (
  id SERIAL PRIMARY KEY,
  feature_id TEXT UNIQUE NOT NULL,
  geometry GEOMETRY(GeometryZ, 4326),
  -- Exploded properties (same names as GeoJSON)
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
  -- Complex nested data as JSONB
  ski_areas JSONB,
  sources JSONB,
  places JSONB,
  elevation_profile JSONB,
  -- Full properties for backward compatibility
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX runs_output_geometry_idx ON output.runs USING GIST (geometry);
CREATE INDEX runs_output_feature_id_idx ON output.runs (feature_id);
CREATE INDEX runs_output_difficulty_idx ON output.runs (difficulty);
CREATE INDEX runs_output_status_idx ON output.runs (status);
CREATE INDEX runs_output_name_idx ON output.runs (name);

-- output.lifts: Processed lift features with exploded properties
CREATE TABLE output.lifts (
  id SERIAL PRIMARY KEY,
  feature_id TEXT UNIQUE NOT NULL,
  geometry GEOMETRY(GeometryZ, 4326),
  -- Exploded properties (same names as GeoJSON)
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
  -- Complex nested data as JSONB
  ski_areas JSONB,
  sources JSONB,
  places JSONB,
  -- Full properties for backward compatibility
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX lifts_output_geometry_idx ON output.lifts USING GIST (geometry);
CREATE INDEX lifts_output_feature_id_idx ON output.lifts (feature_id);
CREATE INDEX lifts_output_lift_type_idx ON output.lifts (lift_type);
CREATE INDEX lifts_output_status_idx ON output.lifts (status);
CREATE INDEX lifts_output_name_idx ON output.lifts (name);

-- output.ski_areas: Processed ski area features with exploded properties
CREATE TABLE output.ski_areas (
  id SERIAL PRIMARY KEY,
  feature_id TEXT UNIQUE NOT NULL,
  geometry GEOMETRY(Geometry, 4326),
  -- Exploded properties (same names as GeoJSON)
  type TEXT,
  name TEXT,
  status TEXT,
  activities TEXT[],
  run_convention TEXT,
  websites TEXT[],
  wikidata_id TEXT,
  -- Complex nested data as JSONB
  sources JSONB,
  places JSONB,
  statistics JSONB,
  -- Full properties for backward compatibility
  properties JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX ski_areas_output_geometry_idx ON output.ski_areas USING GIST (geometry);
CREATE INDEX ski_areas_output_feature_id_idx ON output.ski_areas (feature_id);
CREATE INDEX ski_areas_output_status_idx ON output.ski_areas (status);
CREATE INDEX ski_areas_output_name_idx ON output.ski_areas (name);
CREATE INDEX ski_areas_output_activities_idx ON output.ski_areas USING GIN (activities);

-- ============================================
-- CLUSTERING SCHEMA: Working table (public schema)
-- ============================================

-- objects: Clustering working table
CREATE TABLE objects (
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
CREATE INDEX idx_objects_geom ON objects USING GIST (geom);
CREATE INDEX idx_objects_geog ON objects USING GIST (geography(geom));
CREATE INDEX idx_type_source ON objects(type, source);
CREATE INDEX idx_type_polygon ON objects(type, is_polygon);
CREATE INDEX idx_ski_areas_gin ON objects USING GIN (ski_areas);
CREATE INDEX idx_activities_gin ON objects USING GIN (activities);
EOSQL
    
    # Stop PostgreSQL
    su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D $DATA_DIR stop"
fi

# Run PostgreSQL in foreground as the main process
echo "Starting PostgreSQL in foreground..."
exec su - postgres -c "/usr/lib/postgresql/15/bin/postgres -D $DATA_DIR -c config_file=/etc/postgresql/15/main/postgresql.conf"