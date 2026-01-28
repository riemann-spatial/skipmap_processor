import { Pool, PoolClient } from "pg";
import { PostgresConfig } from "../../Config";
import { getPostgresPoolConfig } from "../../utils/getPostgresPoolConfig";
import {
  LiftObject,
  MapObject,
  MapObjectType,
  RunObject,
  SkiAreaAssignmentSource,
  SkiAreaObject,
} from "../MapObject";
import {
  ClusteringDatabase,
  Cursor,
  GetSkiAreasOptions,
  SearchContext,
} from "./ClusteringDatabase";
import { EmptyCursor, PostgreSQLCursor } from "./Cursors";
import { performanceMonitor } from "./PerformanceMonitor";
import {
  buildUpdateClauses,
  mapObjectToSQLParams,
  rowToMapObject,
} from "./RowMapper";
import { BATCH_SIZES, SQL } from "./sql";
import { ObjectRow, PostgresError, SQLParamValue } from "./types";

/**
 * PostgreSQL implementation of ClusteringDatabase using PostGIS for spatial queries.
 *
 * This implementation provides better concurrency and more advanced spatial operations
 * compared to SQLite + SpatialLite.
 */
export class PostgreSQLClusteringDatabase implements ClusteringDatabase {
  private pool: Pool | null = null;
  private databaseName: string;
  private postgresConfig: PostgresConfig;

  constructor(postgresConfig: PostgresConfig) {
    this.postgresConfig = postgresConfig;
    this.databaseName = postgresConfig.processingDatabase;
  }

  async initialize(): Promise<void> {
    const poolConfig = getPostgresPoolConfig(
      this.databaseName,
      this.postgresConfig,
    );
    poolConfig.max = 10;
    poolConfig.idleTimeoutMillis = 120000;
    poolConfig.connectionTimeoutMillis = 60000;

    this.pool = new Pool(poolConfig);

    try {
      const client = await this.pool.connect();
      await client.query("SELECT 1");
      client.release();
      console.log(
        `✅ PostgreSQL connection established to ${this.databaseName}`,
      );
    } catch (error) {
      throw new Error(
        `Failed to connect to PostgreSQL database ${this.databaseName}: ${error}`,
      );
    }

    await this.enablePostGIS();
    await this.createTables();
    await this.truncateObjectsTable();
    await this.createIndexes();

    console.log(
      `✅ PostgreSQL clustering database initialized: ${this.databaseName}`,
    );
  }

  private async truncateObjectsTable(): Promise<void> {
    const pool = this.ensureInitialized();
    await pool.query("TRUNCATE TABLE objects RESTART IDENTITY");
    console.log("✅ Truncated objects table for fresh clustering");
  }

  async close(): Promise<void> {
    if (this.pool) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));

        const activeConnections = this.pool.totalCount - this.pool.idleCount;
        if (activeConnections > 0) {
          console.warn(
            `Warning: ${activeConnections} active connections during close, waiting for completion...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        await this.pool.end();
        this.pool = null;
        console.log(`✅ Closed connection pool to ${this.databaseName}`);
      } catch (error) {
        console.warn(`Warning during pool cleanup: ${error}`);
        this.pool = null;
      }
    }
  }

  private ensureInitialized(): Pool {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }
    return this.pool;
  }

  private async executeQuery<T>(
    query: string,
    params: SQLParamValue[] = [],
  ): Promise<T> {
    const pool = this.ensureInitialized();

    const client = await pool.connect();
    try {
      const result = await client.query(query, params);
      return result.rows as T;
    } catch (error) {
      console.error(`Query failed: ${query.substring(0, 100)}...`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async executeTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const maxRetries = 5;
    let attempt = 0;

    while (attempt < maxRetries) {
      const pool = this.ensureInitialized();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error: unknown) {
        await client.query("ROLLBACK");

        const pgError = error as PostgresError;
        if (pgError.code === "40P01" && attempt < maxRetries - 1) {
          attempt++;
          console.warn(
            `Deadlock detected, retrying (attempt ${attempt}/${maxRetries})`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 100 + 50),
          );
          continue;
        }

        throw error;
      } finally {
        client.release();
      }
    }

    throw new Error("Transaction failed after maximum retries");
  }

  private async processBatches<T>(
    items: T[],
    batchSize: number,
    processor: (batch: T[], client: PoolClient) => Promise<void>,
  ): Promise<void> {
    await this.executeTransaction(async (client) => {
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await processor(batch, client);
      }
    });
  }

  private async enablePostGIS(): Promise<void> {
    const pool = this.ensureInitialized();
    await pool.query("CREATE EXTENSION IF NOT EXISTS postgis");
    console.log("✅ PostGIS extension enabled");
  }

  private async createTables(): Promise<void> {
    const pool = this.ensureInitialized();
    await pool.query(SQL.CREATE_OBJECTS_TABLE);
    console.log("✅ Created objects table");
  }

  async createIndexes(): Promise<void> {
    const pool = this.ensureInitialized();

    await pool.query(SQL.CREATE_SPATIAL_INDEXES);
    console.log("✅ Created spatial index on geometry column");

    await pool.query(SQL.CREATE_GEOGRAPHY_INDEX);
    console.log("✅ Created spatial index on geography cast");

    await pool.query(SQL.CREATE_COMPOSITE_INDEXES);
    console.log("✅ Created optimized composite indexes");
  }

  async saveObject(object: MapObject): Promise<void> {
    this.ensureInitialized();
    const params = mapObjectToSQLParams(object);
    await this.executeQuery(SQL.INSERT_OBJECT, params);
  }

  async saveObjects(objects: MapObject[]): Promise<void> {
    this.ensureInitialized();

    await this.processBatches(
      objects,
      BATCH_SIZES.BULK_OPERATION,
      async (batch, client) => {
        for (const object of batch) {
          const params = mapObjectToSQLParams(object);
          await client.query(SQL.INSERT_OBJECT, params);
        }
      },
    );
  }

  async updateObject(key: string, updates: Partial<MapObject>): Promise<void> {
    this.ensureInitialized();

    const { setParts, values } = buildUpdateClauses(updates);

    if (setParts.length > 0) {
      values.push(key);
      const query = `UPDATE objects SET ${setParts.join(", ")} WHERE key = $${values.length}`;
      await this.executeQuery(query, values);
    }
  }

  async updateObjects(
    updates: Array<{ key: string; updates: Partial<MapObject> }>,
  ): Promise<void> {
    this.ensureInitialized();

    await this.processBatches(
      updates,
      BATCH_SIZES.BULK_OPERATION,
      async (batch, client) => {
        for (const { key, updates: objectUpdates } of batch) {
          const { setParts, values } = buildUpdateClauses(objectUpdates);

          if (setParts.length > 0) {
            values.push(key);
            const query = `UPDATE objects SET ${setParts.join(", ")} WHERE key = $${values.length}`;
            await client.query(query, values);
          }
        }
      },
    );
  }

  async removeObject(key: string): Promise<void> {
    this.ensureInitialized();

    const objectType = await this.executeQuery<Array<{ type: string }>>(
      "SELECT type FROM objects WHERE key = $1",
      [key],
    );

    if (objectType.length > 0 && objectType[0].type === "SKI_AREA") {
      await this.cleanUpSkiAreaAssociations(key);
    }

    await this.executeQuery("DELETE FROM objects WHERE key = $1", [key]);
  }

  private async cleanUpSkiAreaAssociations(skiAreaId: string): Promise<void> {
    this.ensureInitialized();

    const query = `SELECT key, ski_areas FROM objects
       WHERE ski_areas @> $1::jsonb`;
    const affectedObjects = await this.executeQuery<
      Array<{ key: string; ski_areas: string[] }>
    >(query, [`["${skiAreaId}"]`]);

    await this.executeTransaction(async (client) => {
      for (const obj of affectedObjects) {
        try {
          const currentSkiAreas = obj.ski_areas || [];
          const updatedSkiAreas = currentSkiAreas.filter(
            (id: string) => id !== skiAreaId,
          );
          await client.query(
            "UPDATE objects SET ski_areas = $1 WHERE key = $2",
            [JSON.stringify(updatedSkiAreas), obj.key],
          );
        } catch (error) {
          console.warn(
            `Failed to clean up ski area association for object ${obj.key}:`,
            error,
          );
        }
      }
    });
  }

  async getSkiAreas(
    options: GetSkiAreasOptions,
  ): Promise<Cursor<SkiAreaObject>> {
    const pool = this.ensureInitialized();

    let query = "SELECT * FROM objects WHERE type = 'SKI_AREA'";
    const params: SQLParamValue[] = [];
    let paramIndex = 1;

    if (options.onlySource) {
      query += ` AND source = $${paramIndex++}`;
      params.push(options.onlySource);
    }

    if (options.onlyPolygons) {
      query += " AND is_polygon = true";
    }

    if (options.onlyInPolygon) {
      const polygonGeoJSON = JSON.stringify(options.onlyInPolygon);
      query += ` AND ST_CoveredBy(geom, ST_MakeValid(ST_Force2D(ST_GeomFromGeoJSON($${paramIndex++})), 'method=structure'))`;
      params.push(polygonGeoJSON);
    }

    query += " ORDER BY key";

    const batchSize = options.useBatching
      ? BATCH_SIZES.DEFAULT
      : Number.MAX_SAFE_INTEGER;

    return new PostgreSQLCursor<SkiAreaObject>(
      pool,
      query,
      params,
      (row) => rowToMapObject(row) as SkiAreaObject,
      batchSize,
    );
  }

  async getSkiAreasByIds(
    ids: string[],
    useBatching: boolean,
  ): Promise<Cursor<SkiAreaObject>> {
    const pool = this.ensureInitialized();

    if (ids.length === 0) {
      return new EmptyCursor<SkiAreaObject>();
    }

    const placeholders = ids
      .map((_: string, i: number) => `$${i + 1}`)
      .join(",");
    const query = `SELECT * FROM objects WHERE type = 'SKI_AREA' AND key IN (${placeholders}) ORDER BY key`;

    const batchSize = useBatching
      ? BATCH_SIZES.DEFAULT
      : Number.MAX_SAFE_INTEGER;

    return new PostgreSQLCursor<SkiAreaObject>(
      pool,
      query,
      ids,
      (row) => rowToMapObject(row) as SkiAreaObject,
      batchSize,
    );
  }

  async getAllRuns(useBatching: boolean): Promise<Cursor<RunObject>> {
    const pool = this.ensureInitialized();

    const query = "SELECT * FROM objects WHERE type = 'RUN' ORDER BY key";
    const batchSize = useBatching
      ? BATCH_SIZES.DEFAULT
      : Number.MAX_SAFE_INTEGER;

    return new PostgreSQLCursor<RunObject>(
      pool,
      query,
      [],
      (row) => rowToMapObject(row) as RunObject,
      batchSize,
    );
  }

  async getAllLifts(useBatching: boolean): Promise<Cursor<LiftObject>> {
    const pool = this.ensureInitialized();

    const query = "SELECT * FROM objects WHERE type = 'LIFT' ORDER BY key";
    const batchSize = useBatching
      ? BATCH_SIZES.DEFAULT
      : Number.MAX_SAFE_INTEGER;

    return new PostgreSQLCursor<LiftObject>(
      pool,
      query,
      [],
      (row) => rowToMapObject(row) as LiftObject,
      batchSize,
    );
  }

  async findNearbyObjects(
    geometry: GeoJSON.Geometry,
    context: SearchContext,
  ): Promise<MapObject[]> {
    this.ensureInitialized();

    let query: string;
    let paramIndex = 1;
    let params: SQLParamValue[];

    const geometryGeoJSON = JSON.stringify(geometry);

    if (context.bufferDistanceKm !== undefined) {
      const bufferMeters = context.bufferDistanceKm * 1000;

      if (context.searchType === "contains") {
        query = `
          SELECT * FROM objects
          WHERE ST_CoveredBy(geom, ST_Buffer(geography(ST_MakeValid(ST_Force2D(ST_GeomFromGeoJSON($${paramIndex++})), 'method=structure')), $${paramIndex++})::geometry)
            AND type != 'SKI_AREA'
        `;
        params = [geometryGeoJSON, bufferMeters];
      } else {
        query = `
          SELECT * FROM objects
          WHERE ST_DWithin(geography(geom), geography(ST_MakeValid(ST_Force2D(ST_GeomFromGeoJSON($${paramIndex++})), 'method=structure')), $${paramIndex++})
            AND type != 'SKI_AREA'
        `;
        params = [geometryGeoJSON, bufferMeters];
      }
      paramIndex = 3;
    } else {
      if (context.searchType === "contains") {
        query = `
          SELECT * FROM objects
          WHERE ST_CoveredBy(geom, ST_MakeValid(ST_Force2D(ST_GeomFromGeoJSON($${paramIndex++})), 'method=structure'))
            AND type != 'SKI_AREA'
        `;
      } else {
        query = `
          SELECT * FROM objects
          WHERE ST_Intersects(geom, ST_MakeValid(ST_Force2D(ST_GeomFromGeoJSON($${paramIndex++})), 'method=structure'))
            AND type != 'SKI_AREA'
        `;
      }
      params = [geometryGeoJSON];
      paramIndex = 2;
    }

    if (context.activities.length > 0) {
      const activityConditions = context.activities
        .map(() => `activities @> $${paramIndex++}::jsonb`)
        .join(" OR ");
      query += ` AND (${activityConditions})`;
      context.activities.forEach((activity) => {
        params.push(JSON.stringify([activity]));
      });
    }

    query += ` AND NOT (ski_areas @> $${paramIndex++}::jsonb)`;
    params.push(JSON.stringify([context.id]));

    if (context.excludeObjectsAlreadyInSkiArea) {
      query += " AND (ski_areas = '[]'::jsonb OR ski_areas IS NULL)";
    }

    if (context.alreadyVisited.length > 0) {
      const placeholders = context.alreadyVisited
        .map((_: string, i: number) => `$${paramIndex + i}`)
        .join(",");
      query += ` AND key NOT IN (${placeholders})`;
      params.push(...context.alreadyVisited);
      paramIndex += context.alreadyVisited.length;
    }

    return performanceMonitor.measure(
      "Find nearby objects",
      async () => {
        const rows = await this.executeQuery<ObjectRow[]>(query, params);
        const allFound = rows.map((row) => rowToMapObject(row));
        allFound.forEach((object) => context.alreadyVisited.push(object._key));
        return allFound;
      },
      () => ({
        poolStats: { idle: this.pool?.idleCount, total: this.pool?.totalCount },
      }),
    );
  }

  async getObjectsForSkiArea(skiAreaId: string): Promise<MapObject[]> {
    this.ensureInitialized();

    const query = `SELECT * FROM objects
       WHERE ski_areas @> $1::jsonb AND type != 'SKI_AREA'`;
    const rows = await this.executeQuery<ObjectRow[]>(query, [
      JSON.stringify([skiAreaId]),
    ]);

    return rows.map((row) => rowToMapObject(row));
  }

  async markObjectsAsPartOfSkiArea(
    skiAreaId: string,
    objectKeys: string[],
    assignedFrom: SkiAreaAssignmentSource,
  ): Promise<void> {
    this.ensureInitialized();

    if (objectKeys.length === 0) {
      return;
    }

    const sortedKeys = [...objectKeys].sort();

    await this.executeTransaction(async (client) => {
      const assignment = { skiAreaId, assignedFrom };
      const assignmentJson = JSON.stringify([assignment]);
      const isInSkiAreaPolygon = assignedFrom === "polygon";

      // Check if this ski area ID is already assigned (regardless of source)
      // by looking for any object with matching skiAreaId in the array
      await client.query(
        `UPDATE objects
         SET ski_areas = CASE
           WHEN EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(ski_areas, '[]'::jsonb)) elem
             WHERE elem->>'skiAreaId' = $1
           ) THEN ski_areas
           ELSE COALESCE(ski_areas, '[]'::jsonb) || $2::jsonb
         END,
         is_in_ski_area_polygon = is_in_ski_area_polygon OR $3,
         is_basis_for_new_ski_area = false
         WHERE key = ANY($4::text[])`,
        [skiAreaId, assignmentJson, isInSkiAreaPolygon, sortedKeys],
      );
    });
  }

  async getNextUnassignedRun(): Promise<MapObject | null> {
    this.ensureInitialized();

    const query = `
      SELECT * FROM objects
      WHERE type = 'RUN'
        AND is_basis_for_new_ski_area = true
      LIMIT 1
    `;

    const rows = await this.executeQuery<ObjectRow[]>(query, []);
    const run = rows.length > 0 ? rowToMapObject(rows[0]) : null;

    if (run && run.activities.length === 0) {
      throw new Error("No activities for run");
    }
    return run;
  }

  async streamSkiAreas(): Promise<AsyncIterable<SkiAreaObject>> {
    this.ensureInitialized();

    const query = "SELECT * FROM objects WHERE type = 'SKI_AREA'";
    const rows = await this.executeQuery<ObjectRow[]>(query, []);

    return {
      async *[Symbol.asyncIterator]() {
        for (const row of rows) {
          yield rowToMapObject(row) as SkiAreaObject;
        }
      },
    };
  }

  async getObjectById(objectId: string): Promise<MapObject | null> {
    this.ensureInitialized();

    const query = "SELECT * FROM objects WHERE key = $1";
    const rows = await this.executeQuery<ObjectRow[]>(query, [objectId]);

    return rows.length > 0 ? rowToMapObject(rows[0]) : null;
  }

  async getObjectDerivedSkiAreaGeometry(
    skiAreaId: string,
  ): Promise<GeoJSON.Geometry> {
    this.ensureInitialized();

    try {
      const rows = await this.executeQuery<
        Array<{ geometry: GeoJSON.Geometry }>
      >(SQL.DERIVED_GEOMETRY, [JSON.stringify([skiAreaId]), skiAreaId]);

      if (rows.length === 0 || !rows[0].geometry) {
        throw new Error(`No geometry found for ski area ${skiAreaId}`);
      }

      return rows[0].geometry;
    } catch (error) {
      console.warn(
        `Failed to get derived geometry for ski area ${skiAreaId}, querying ski area geometry directly:`,
        error,
      );

      const fallbackQuery =
        "SELECT geometry FROM objects WHERE key = $1 AND type = 'SKI_AREA'";
      const rows = await this.executeQuery<
        Array<{ geometry: GeoJSON.Geometry }>
      >(fallbackQuery, [skiAreaId]);

      if (rows.length === 0) {
        throw new Error(`Ski area ${skiAreaId} not found`);
      }

      return rows[0].geometry;
    }
  }
}
