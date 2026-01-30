import { configFromEnvironment } from "../Config";
import { DatabaseInitializer } from "../utils/DatabaseInitializer";

async function main(): Promise<void> {
  const config = configFromEnvironment();
  const postgresConfig = config.postgresCache;
  const initializer = new DatabaseInitializer(postgresConfig);

  console.log("=== Database Initialization ===");
  console.log(`Host: ${postgresConfig.host}:${postgresConfig.port}`);
  console.log(`Processing database: ${postgresConfig.processingDatabase}`);
  console.log(`Cache database: ${postgresConfig.cacheDatabase}`);

  // Test connection to external PostgreSQL
  console.log("\nTesting connection to PostgreSQL...");
  await initializer.testConnection();

  // Drop and recreate processing database (always fresh for each run)
  console.log("\nInitializing processing database...");
  await initializer.initializeDatabase(
    postgresConfig.processingDatabase,
    true, // dropIfExists = true
  );
  await initializer.enablePostGIS(postgresConfig.processingDatabase);
  await initializer.createProcessingSchema();

  // Create cache database if it doesn't exist (preserve for faster subsequent runs)
  console.log("\nInitializing cache database...");
  await initializer.initializeDatabase(
    postgresConfig.cacheDatabase,
    false, // dropIfExists = false
  );
  await initializer.enablePostGIS(postgresConfig.cacheDatabase);

  console.log("\n=== Database initialization complete ===");
}

main().catch((error) => {
  console.error("Database initialization failed:", error);
  process.exit(1);
});
