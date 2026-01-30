import { Pool, PoolClient } from "pg";
import { PostgresConfig } from "../Config";
import { getPostgresPoolConfig } from "./getPostgresPoolConfig";

export class DatabaseInitializer {
  private config: PostgresConfig;

  constructor(config: PostgresConfig) {
    this.config = config;
  }

  async testConnection(): Promise<void> {
    const pool = new Pool(getPostgresPoolConfig("postgres", this.config));
    try {
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      console.log(
        `Successfully connected to PostgreSQL at ${this.config.host}:${this.config.port}`,
      );
    } finally {
      await pool.end();
    }
  }

  async initializeDatabase(
    dbName: string,
    dropIfExists: boolean,
  ): Promise<void> {
    const pool = new Pool(getPostgresPoolConfig("postgres", this.config));
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          "SELECT 1 FROM pg_database WHERE datname = $1",
          [dbName],
        );

        if (result.rows.length > 0) {
          if (dropIfExists) {
            console.log(`Dropping existing database: ${dbName}`);
            await client.query(
              `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
              [dbName],
            );
            await client.query(`DROP DATABASE "${dbName}"`);
            console.log(`Creating database: ${dbName}`);
            await client.query(`CREATE DATABASE "${dbName}"`);
          } else {
            console.log(`Database ${dbName} already exists, skipping creation`);
            return;
          }
        } else {
          console.log(`Creating database: ${dbName}`);
          await client.query(`CREATE DATABASE "${dbName}"`);
        }
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }

  async enablePostGIS(dbName: string): Promise<void> {
    const pool = new Pool(getPostgresPoolConfig(dbName, this.config));
    try {
      const client = await pool.connect();
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS postgis");
        console.log(`Enabled PostGIS extension on ${dbName}`);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }

  async createProcessingSchema(): Promise<void> {
    const pool = new Pool(
      getPostgresPoolConfig(this.config.processingDatabase, this.config),
    );
    try {
      const client = await pool.connect();
      try {
        await this.createSchemas(client);
        await this.createInputTables(client);
        await this.createOutputTables(client);
        await this.createClusteringTable(client);
        console.log(
          `Created schemas and tables in ${this.config.processingDatabase}`,
        );
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }

  private async createSchemas(client: PoolClient): Promise<void> {
    const user = this.config.user;
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS input AUTHORIZATION "${user}";
      CREATE SCHEMA IF NOT EXISTS output AUTHORIZATION "${user}";
      GRANT ALL ON SCHEMA input TO "${user}";
      GRANT ALL ON SCHEMA output TO "${user}";
      GRANT ALL ON SCHEMA public TO "${user}";
    `);
  }

  private async createInputTables(client: PoolClient): Promise<void> {
    await client.query(`
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

      -- input.highways: Raw highway features from Overpass
      CREATE TABLE input.highways (
        id SERIAL PRIMARY KEY,
        osm_id BIGINT,
        osm_type TEXT,
        geometry GEOMETRY(Geometry, 4326),
        properties JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX highways_input_geometry_idx ON input.highways USING GIST (geometry);
      CREATE INDEX highways_input_osm_id_idx ON input.highways (osm_id);
    `);
  }

  private async createOutputTables(client: PoolClient): Promise<void> {
    await client.query(`
      -- output.runs: Processed run features with exploded properties
      CREATE TABLE output.runs (
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
      CREATE INDEX lifts_output_geometry_idx ON output.lifts USING GIST (geometry);
      CREATE INDEX lifts_output_feature_id_idx ON output.lifts (feature_id);
      CREATE INDEX lifts_output_lift_type_idx ON output.lifts (lift_type);
      CREATE INDEX lifts_output_status_idx ON output.lifts (status);
      CREATE INDEX lifts_output_name_idx ON output.lifts (name);

      -- output.ski_areas: Processed ski area features with exploded properties
      CREATE TABLE output.ski_areas (
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
      CREATE INDEX ski_areas_output_geometry_idx ON output.ski_areas USING GIST (geometry);
      CREATE INDEX ski_areas_output_feature_id_idx ON output.ski_areas (feature_id);
      CREATE INDEX ski_areas_output_status_idx ON output.ski_areas (status);
      CREATE INDEX ski_areas_output_name_idx ON output.ski_areas (name);
      CREATE INDEX ski_areas_output_activities_idx ON output.ski_areas USING GIN (activities);

      -- output.highways: Processed highway features with exploded properties
      CREATE TABLE output.highways (
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
      CREATE INDEX highways_output_geometry_idx ON output.highways USING GIST (geometry);
      CREATE INDEX highways_output_feature_id_idx ON output.highways (feature_id);
      CREATE INDEX highways_output_highway_type_idx ON output.highways (highway_type);
      CREATE INDEX highways_output_status_idx ON output.highways (status);
      CREATE INDEX highways_output_name_idx ON output.highways (name);
      CREATE INDEX highways_output_is_road_idx ON output.highways (is_road);
      CREATE INDEX highways_output_is_walkway_idx ON output.highways (is_walkway);
    `);
  }

  private async createClusteringTable(client: PoolClient): Promise<void> {
    await client.query(`
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
    `);
  }
}
