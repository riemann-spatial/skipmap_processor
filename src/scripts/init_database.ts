import { configFromEnvironment } from "../Config";
import { DatabaseInitializer } from "../utils/DatabaseInitializer";
import { Logger } from "../utils/Logger";

async function main(): Promise<void> {
  const config = configFromEnvironment();
  const postgresConfig = config.postgresCache;
  const initializer = new DatabaseInitializer(postgresConfig);

  Logger.log("=== Database Initialization ===");
  Logger.log(`Host: ${postgresConfig.host}:${postgresConfig.port}`);
  Logger.log(`Processing database: ${postgresConfig.processingDatabase}`);
  Logger.log(`Cache database: ${postgresConfig.cacheDatabase}`);

  // Test connection to external PostgreSQL
  Logger.log("\nTesting connection to PostgreSQL...");
  await initializer.testConnection();

  // Drop and recreate processing database (always fresh for each run)
  Logger.log("\nInitializing processing database...");
  await initializer.initializeDatabase(
    postgresConfig.processingDatabase,
    true, // dropIfExists = true
  );
  await initializer.enablePostGIS(postgresConfig.processingDatabase);
  await initializer.createProcessingSchema();

  // Create cache database if it doesn't exist (preserve for faster subsequent runs)
  Logger.log("\nInitializing cache database...");
  await initializer.initializeDatabase(
    postgresConfig.cacheDatabase,
    false, // dropIfExists = false
  );
  await initializer.enablePostGIS(postgresConfig.cacheDatabase);

  Logger.log("\n=== Database initialization complete ===");
}

main().catch((error) => {
  Logger.error("Database initialization failed:", error);
  process.exit(1);
});
