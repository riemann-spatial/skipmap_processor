import { Pool } from "pg";
import { getPostgresPoolConfig } from "./utils/getPostgresPoolConfig";
import { getPostgresTestConfig } from "./Config";

// Jest global setup function
export default async function globalSetup(): Promise<void> {
  console.log("Setting up test database...");

  // Create test database if it doesn't exist
  const adminConfig = getPostgresTestConfig();
  const adminPool = new Pool(getPostgresPoolConfig("postgres", adminConfig));

  try {
    const client = await adminPool.connect();
    try {
      // Check if test database exists
      const result = await client.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        ["openskidata_test"],
      );

      if (result.rows.length === 0) {
        // Database doesn't exist, create it
        await client.query('CREATE DATABASE "openskidata_test"');
        console.log("Created test database: openskidata_test");
      } else {
        console.log("Test database openskidata_test already exists");
      }
    } finally {
      client.release();
    }
  } catch (error) {
    console.warn("Failed to setup test database:", error);
    console.warn("Tests may fail due to database connectivity issues");
    await adminPool.end();
    return;
  }
  await adminPool.end();

  // Ensure PostGIS extension and input/processing/output schemas exist
  const testPool = new Pool(
    getPostgresPoolConfig("openskidata_test", adminConfig),
  );
  try {
    const testClient = await testPool.connect();
    try {
      await testClient.query("CREATE EXTENSION IF NOT EXISTS postgis");
      const user = adminConfig.user;
      await testClient.query(`
        CREATE SCHEMA IF NOT EXISTS input AUTHORIZATION "${user}";
        CREATE SCHEMA IF NOT EXISTS processing AUTHORIZATION "${user}";
        CREATE SCHEMA IF NOT EXISTS output AUTHORIZATION "${user}";
        GRANT ALL ON SCHEMA input TO "${user}";
        GRANT ALL ON SCHEMA processing TO "${user}";
        GRANT ALL ON SCHEMA output TO "${user}";
      `);
      // Drop and recreate input tables to ensure schema is up to date
      await testClient.query(`
        DROP TABLE IF EXISTS input.runs CASCADE;
        DROP TABLE IF EXISTS input.lifts CASCADE;
        DROP TABLE IF EXISTS input.ski_areas CASCADE;
        DROP TABLE IF EXISTS input.ski_area_sites CASCADE;
        DROP TABLE IF EXISTS input.highways CASCADE;

        CREATE TABLE input.runs (
          id SERIAL PRIMARY KEY,
          osm_id BIGINT,
          osm_type TEXT,
          geometry GEOMETRY(Geometry, 4326),
          properties JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE input.lifts (
          id SERIAL PRIMARY KEY,
          osm_id BIGINT,
          osm_type TEXT,
          geometry GEOMETRY(Geometry, 4326),
          properties JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE input.ski_areas (
          id SERIAL PRIMARY KEY,
          osm_id BIGINT,
          osm_type TEXT,
          geometry GEOMETRY(Geometry, 4326),
          properties JSONB,
          source TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE input.ski_area_sites (
          id SERIAL PRIMARY KEY,
          osm_id BIGINT,
          properties JSONB,
          members JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE input.highways (
          id SERIAL PRIMARY KEY,
          osm_id BIGINT,
          osm_type TEXT,
          geometry GEOMETRY(Geometry, 4326),
          properties JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // Drop and recreate processing tables
      await testClient.query(`
        DROP TABLE IF EXISTS processing.ski_areas CASCADE;
        DROP TABLE IF EXISTS processing.runs CASCADE;
        DROP TABLE IF EXISTS processing.lifts CASCADE;
        DROP TABLE IF EXISTS processing.highways CASCADE;
        DROP TABLE IF EXISTS processing.peaks CASCADE;

        CREATE TABLE processing.ski_areas (
          id SERIAL PRIMARY KEY,
          feature_id TEXT NOT NULL,
          geometry GEOMETRY(GeometryZ, 4326),
          properties JSONB NOT NULL
        );
        CREATE TABLE processing.runs (
          id SERIAL PRIMARY KEY,
          feature_id TEXT NOT NULL,
          geometry GEOMETRY(GeometryZ, 4326),
          properties JSONB NOT NULL
        );
        CREATE TABLE processing.lifts (
          id SERIAL PRIMARY KEY,
          feature_id TEXT NOT NULL,
          geometry GEOMETRY(GeometryZ, 4326),
          properties JSONB NOT NULL
        );
        CREATE TABLE processing.highways (
          id SERIAL PRIMARY KEY,
          feature_id TEXT NOT NULL,
          geometry GEOMETRY(GeometryZ, 4326),
          properties JSONB NOT NULL
        );
        CREATE TABLE processing.peaks (
          id SERIAL PRIMARY KEY,
          feature_id TEXT NOT NULL,
          geometry GEOMETRY(GeometryZ, 4326),
          properties JSONB NOT NULL
        );
      `);

      // Drop and recreate output tables
      await testClient.query(`
        DROP TABLE IF EXISTS output.runs CASCADE;
        DROP TABLE IF EXISTS output.lifts CASCADE;
        DROP TABLE IF EXISTS output.ski_areas CASCADE;
        DROP TABLE IF EXISTS output.highways CASCADE;
        DROP TABLE IF EXISTS output.peaks CASCADE;

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

        CREATE TABLE output.peaks (
          id SERIAL PRIMARY KEY,
          feature_id TEXT UNIQUE NOT NULL,
          geometry GEOMETRY(GeometryZ, 4326),
          type TEXT,
          name TEXT,
          elevation REAL,
          elevation_source TEXT,
          prominence REAL,
          natural_type TEXT,
          websites TEXT[],
          wikidata_id TEXT,
          wikipedia_id TEXT,
          sources JSONB,
          properties JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      console.log(
        "Ensured input, processing, and output schema and tables exist",
      );
    } finally {
      testClient.release();
    }
  } finally {
    await testPool.end();
  }
}
