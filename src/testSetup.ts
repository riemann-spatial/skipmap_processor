import { Pool } from "pg";
import { getPostgresPoolConfig } from "./utils/getPostgresPoolConfig";
import { getPostgresTestConfig } from "./Config";

// Jest global setup function
export default async function globalSetup(): Promise<void> {
  console.log("🔧 Setting up test database...");

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
        console.log("✅ Created test database: openskidata_test");
      } else {
        console.log("✅ Test database openskidata_test already exists");
      }
    } finally {
      client.release();
    }
  } catch (error) {
    console.warn("⚠️ Failed to setup test database:", error);
    console.warn("Tests may fail due to database connectivity issues");
    await adminPool.end();
    return;
  }
  await adminPool.end();

  // Ensure PostGIS extension and input/output schemas exist
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
        CREATE SCHEMA IF NOT EXISTS output AUTHORIZATION "${user}";
        GRANT ALL ON SCHEMA input TO "${user}";
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
      console.log("✅ Ensured input schema and tables exist");
    } finally {
      testClient.release();
    }
  } finally {
    await testPool.end();
  }
}
