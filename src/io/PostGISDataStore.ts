import { Pool, PoolClient } from "pg";
import { Readable } from "stream";
import { PostgresConfig } from "../Config";
import { getPostgresPoolConfig } from "../utils/getPostgresPoolConfig";
import { Logger } from "../utils/Logger";

export interface InputFeature {
  osm_id: number;
  osm_type: string;
  geometry: GeoJSON.Geometry;
  properties: Record<string, unknown>;
}

export interface InputSkiAreaFeature extends InputFeature {
  source: "openstreetmap" | "skimap";
}

export interface InputSkiAreaSiteMember {
  type: string;
  ref: number;
}

export interface InputSkiAreaSite {
  osm_id: number;
  properties: Record<string, unknown>;
  members: InputSkiAreaSiteMember[];
}

export interface OutputFeature {
  feature_id: string;
  geometry: GeoJSON.Geometry;
  properties: Record<string, unknown>;
}

// Helper to safely extract array from properties
function toTextArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return null;
}

// Helper to safely extract boolean
function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

// Helper to safely extract number
function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }
  return null;
}

// Helper to safely extract integer (rounds decimals)
function toInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Math.round(value);
  }
  return null;
}

// Helper to safely extract string
function toString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return null;
}

export class PostGISDataStore {
  private pool: Pool;
  private config: PostgresConfig;

  constructor(config: PostgresConfig) {
    this.config = config;
    this.pool = new Pool(
      getPostgresPoolConfig(config.processingDatabase, config),
    );
  }

  async resetInputTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      Logger.log("Resetting input tables in openskidata database...");
      await client.query("TRUNCATE TABLE input.runs RESTART IDENTITY CASCADE");
      await client.query("TRUNCATE TABLE input.lifts RESTART IDENTITY CASCADE");
      await client.query(
        "TRUNCATE TABLE input.ski_areas RESTART IDENTITY CASCADE",
      );
      await client.query(
        "TRUNCATE TABLE input.ski_area_sites RESTART IDENTITY CASCADE",
      );
      // Conditionally truncate highways table if it exists
      await client.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'input' AND table_name = 'highways') THEN
            TRUNCATE TABLE input.highways RESTART IDENTITY CASCADE;
          END IF;
        END $$;
      `);
      Logger.log("Input tables reset complete.");
    } finally {
      client.release();
    }
  }

  async resetOutputTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      Logger.log("Resetting output tables in openskidata database...");
      await client.query("TRUNCATE TABLE output.runs RESTART IDENTITY CASCADE");
      await client.query(
        "TRUNCATE TABLE output.lifts RESTART IDENTITY CASCADE",
      );
      await client.query(
        "TRUNCATE TABLE output.ski_areas RESTART IDENTITY CASCADE",
      );
      // Conditionally truncate highways table if it exists
      await client.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'output' AND table_name = 'highways') THEN
            TRUNCATE TABLE output.highways RESTART IDENTITY CASCADE;
          END IF;
        END $$;
      `);
      Logger.log("Output tables reset complete.");
    } finally {
      client.release();
    }
  }

  async saveInputRuns(features: InputFeature[]): Promise<void> {
    await this.batchInsertFeatures("input.runs", features);
  }

  async saveInputLifts(features: InputFeature[]): Promise<void> {
    await this.batchInsertFeatures("input.lifts", features);
  }

  async saveInputHighways(features: InputFeature[]): Promise<void> {
    await this.batchInsertFeatures("input.highways", features);
  }

  async saveInputSkiAreas(features: InputSkiAreaFeature[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      const batchSize = 1000;
      for (let i = 0; i < features.length; i += batchSize) {
        const batch = features.slice(i, i + batchSize);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        batch.forEach((feature, idx) => {
          const offset = idx * 5;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, ST_GeomFromGeoJSON($${offset + 3}), $${offset + 4}, $${offset + 5})`,
          );
          values.push(
            feature.osm_id,
            feature.osm_type,
            JSON.stringify(feature.geometry),
            JSON.stringify(feature.properties),
            feature.source,
          );
        });

        await client.query(
          `INSERT INTO input.ski_areas (osm_id, osm_type, geometry, properties, source)
           VALUES ${placeholders.join(", ")}`,
          values,
        );
      }
    } finally {
      client.release();
    }
  }

  async saveInputSkiAreaSites(sites: InputSkiAreaSite[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      const batchSize = 1000;
      for (let i = 0; i < sites.length; i += batchSize) {
        const batch = sites.slice(i, i + batchSize);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        batch.forEach((site, idx) => {
          const offset = idx * 3;
          placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
          values.push(
            site.osm_id,
            JSON.stringify(site.properties),
            JSON.stringify(site.members),
          );
        });

        await client.query(
          `INSERT INTO input.ski_area_sites (osm_id, properties, members)
           VALUES ${placeholders.join(", ")}`,
          values,
        );
      }
    } finally {
      client.release();
    }
  }

  async saveOutputRuns(features: OutputFeature[]): Promise<void> {
    await this.batchInsertOutputRuns(features);
  }

  async saveOutputLifts(features: OutputFeature[]): Promise<void> {
    await this.batchInsertOutputLifts(features);
  }

  async saveOutputSkiAreas(features: OutputFeature[]): Promise<void> {
    await this.batchInsertOutputSkiAreas(features);
  }

  async saveOutputHighways(features: OutputFeature[]): Promise<void> {
    await this.batchInsertOutputHighways(features);
  }

  async createOutput2DViews(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `CREATE OR REPLACE VIEW "output".lifts_2d AS
         SELECT lifts.id,
                lifts.feature_id,
                st_force2d(lifts.geometry) AS geometry,
                lifts.type,
                lifts.name,
                lifts.ref,
                lifts.ref_fr_cairn,
                lifts.description,
                lifts.lift_type,
                lifts.status,
                lifts.oneway,
                lifts.occupancy,
                lifts.capacity,
                lifts.duration,
                lifts.bubble,
                lifts.heating,
                lifts.detachable,
                lifts.websites,
                lifts.wikidata_id,
                lifts.sources,
                lifts.places,
                lifts.properties,
                lifts.created_at,
                (
                  SELECT string_agg((elem.value -> 'properties') ->> 'name', ', ')
                  FROM jsonb_array_elements(lifts.ski_areas) elem(value)
                ) AS ski_area_names
         FROM output.lifts`,
      );

      await client.query(
        `CREATE OR REPLACE VIEW "output".runs_2d AS
         SELECT runs.id,
                runs.feature_id,
                st_force2d(runs.geometry) AS geometry,
                runs.type,
                runs.name,
                runs.ref,
                runs.description,
                runs.uses,
                runs.difficulty,
                runs.difficulty_convention,
                runs.oneway,
                runs.gladed,
                runs.patrolled,
                runs.lit,
                runs.grooming,
                runs.status,
                runs.websites,
                runs.wikidata_id,
                runs.sources,
                runs.places,
                runs.elevation_profile,
                runs.properties,
                runs.created_at,
                (
                  SELECT string_agg((elem.value -> 'properties') ->> 'name', ', ')
                  FROM jsonb_array_elements(runs.ski_areas) elem(value)
                ) AS ski_area_names
         FROM output.runs`,
      );

      await client.query(
        `CREATE OR REPLACE VIEW "output".ski_areas_2d AS
         SELECT ski_areas.id,
                ski_areas.feature_id,
                st_force2d(ski_areas.geometry) AS geometry,
                ski_areas.type,
                ski_areas.name,
                ski_areas.status,
                ski_areas.activities,
                ski_areas.run_convention,
                ski_areas.websites,
                ski_areas.wikidata_id,
                ski_areas.sources,
                ski_areas.places,
                ski_areas.statistics,
                ski_areas.properties,
                ski_areas.created_at
         FROM output.ski_areas`,
      );

      // Create highways_2d view if highways table exists
      await client.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'output' AND table_name = 'highways') THEN
            EXECUTE $view$
              CREATE OR REPLACE VIEW "output".highways_2d AS
              SELECT highways.id,
                     highways.feature_id,
                     st_force2d(highways.geometry) AS geometry,
                     highways.type,
                     highways.name,
                     highways.ref,
                     highways.highway_type,
                     highways.is_road,
                     highways.is_walkway,
                     highways.is_private,
                     highways.surface,
                     highways.smoothness,
                     highways.lit,
                     highways.status,
                     highways.websites,
                     highways.wikidata_id,
                     highways.ski_areas,
                     highways.sources,
                     highways.properties,
                     highways.created_at,
                     (
                       SELECT string_agg((elem.value -> 'properties') ->> 'name', ', ')
                       FROM jsonb_array_elements(highways.ski_areas) elem(value)
                     ) AS ski_area_names
              FROM output.highways
            $view$;
          END IF;
        END $$;
      `);
    } finally {
      client.release();
    }
  }

  async *streamInputRuns(): AsyncGenerator<GeoJSON.Feature> {
    yield* this.streamFeatures("input.runs");
  }

  async *streamInputLifts(): AsyncGenerator<GeoJSON.Feature> {
    yield* this.streamFeatures("input.lifts");
  }

  async *streamInputHighways(): AsyncGenerator<GeoJSON.Feature> {
    yield* this.streamFeatures("input.highways");
  }

  async *streamInputSkiAreas(
    source?: "openstreetmap" | "skimap",
  ): AsyncGenerator<GeoJSON.Feature> {
    yield* this.streamFeatures("input.ski_areas", source);
  }

  async *streamInputSkiAreaSites(): AsyncGenerator<{
    osm_id: number;
    properties: Record<string, unknown>;
    members: InputSkiAreaSiteMember[];
  }> {
    const client = await this.pool.connect();
    try {
      const batchSize = 1000;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const result = await client.query(
          `SELECT osm_id, properties, members
           FROM input.ski_area_sites
           ORDER BY id
           LIMIT $1 OFFSET $2`,
          [batchSize, offset],
        );

        for (const row of result.rows) {
          yield {
            osm_id: row.osm_id,
            properties: row.properties,
            members: row.members,
          };
        }

        hasMore = result.rows.length === batchSize;
        offset += batchSize;
      }
    } finally {
      client.release();
    }
  }

  async *streamOutputRuns(): AsyncGenerator<GeoJSON.Feature> {
    yield* this.streamOutputFeatures("output.runs");
  }

  async *streamOutputLifts(): AsyncGenerator<GeoJSON.Feature> {
    yield* this.streamOutputFeatures("output.lifts");
  }

  async *streamOutputSkiAreas(): AsyncGenerator<GeoJSON.Feature> {
    yield* this.streamOutputFeatures("output.ski_areas");
  }

  async *streamOutputHighways(): AsyncGenerator<GeoJSON.Feature> {
    yield* this.streamOutputFeatures("output.highways");
  }

  async getInputRunsCount(): Promise<number> {
    return this.getCount("input.runs");
  }

  async getInputLiftsCount(): Promise<number> {
    return this.getCount("input.lifts");
  }

  async getInputSkiAreasCount(): Promise<number> {
    return this.getCount("input.ski_areas");
  }

  async getInputHighwaysCount(): Promise<number> {
    return this.getCount("input.highways");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async batchInsertFeatures(
    tableName: string,
    features: InputFeature[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const batchSize = 1000;
      for (let i = 0; i < features.length; i += batchSize) {
        const batch = features.slice(i, i + batchSize);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        batch.forEach((feature, idx) => {
          const offset = idx * 4;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, ST_GeomFromGeoJSON($${offset + 3}), $${offset + 4})`,
          );
          values.push(
            feature.osm_id,
            feature.osm_type,
            JSON.stringify(feature.geometry),
            JSON.stringify(feature.properties),
          );
        });

        await client.query(
          `INSERT INTO ${tableName} (osm_id, osm_type, geometry, properties)
           VALUES ${placeholders.join(", ")}`,
          values,
        );
      }
    } finally {
      client.release();
    }
  }

  private async batchInsertOutputRuns(
    features: OutputFeature[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const batchSize = 500; // Smaller batch due to more columns
      for (let i = 0; i < features.length; i += batchSize) {
        const batch = features.slice(i, i + batchSize);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        batch.forEach((feature, idx) => {
          const p = feature.properties;
          const numCols = 17;
          const offset = idx * numCols;
          placeholders.push(
            `($${offset + 1}, ST_Force3D(ST_GeomFromGeoJSON($${offset + 2})), $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17})`,
          );
          values.push(
            feature.feature_id,
            JSON.stringify(feature.geometry),
            toString(p.type),
            toString(p.name),
            toString(p.ref),
            toString(p.description),
            toTextArray(p.uses),
            toString(p.difficulty),
            toString(p.difficultyConvention),
            toBoolean(p.oneway),
            toBoolean(p.gladed),
            toBoolean(p.patrolled),
            toBoolean(p.lit),
            toString(p.grooming),
            toString(p.status),
            toTextArray(p.websites),
            toString(p.wikidataID),
          );
        });

        // Second query for JSONB columns
        const jsonValues: unknown[] = [];
        const jsonPlaceholders: string[] = [];
        batch.forEach((feature, idx) => {
          const p = feature.properties;
          const offset = idx * 5;
          jsonPlaceholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`,
          );
          jsonValues.push(
            feature.feature_id,
            p.skiAreas ? JSON.stringify(p.skiAreas) : null,
            p.sources ? JSON.stringify(p.sources) : null,
            p.places ? JSON.stringify(p.places) : null,
            p.elevationProfile ? JSON.stringify(p.elevationProfile) : null,
          );
        });

        await client.query(
          `INSERT INTO output.runs (feature_id, geometry, type, name, ref, description, uses, difficulty, difficulty_convention, oneway, gladed, patrolled, lit, grooming, status, websites, wikidata_id)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (feature_id) DO UPDATE SET
             geometry = EXCLUDED.geometry,
             type = EXCLUDED.type,
             name = EXCLUDED.name,
             ref = EXCLUDED.ref,
             description = EXCLUDED.description,
             uses = EXCLUDED.uses,
             difficulty = EXCLUDED.difficulty,
             difficulty_convention = EXCLUDED.difficulty_convention,
             oneway = EXCLUDED.oneway,
             gladed = EXCLUDED.gladed,
             patrolled = EXCLUDED.patrolled,
             lit = EXCLUDED.lit,
             grooming = EXCLUDED.grooming,
             status = EXCLUDED.status,
             websites = EXCLUDED.websites,
             wikidata_id = EXCLUDED.wikidata_id`,
          values,
        );

        // Update JSONB columns and full properties
        for (let j = 0; j < batch.length; j++) {
          const feature = batch[j];
          const p = feature.properties;
          await client.query(
            `UPDATE output.runs SET
               ski_areas = $2,
               sources = $3,
               places = $4,
               elevation_profile = $5,
               properties = $6
             WHERE feature_id = $1`,
            [
              feature.feature_id,
              p.skiAreas ? JSON.stringify(p.skiAreas) : null,
              p.sources ? JSON.stringify(p.sources) : null,
              p.places ? JSON.stringify(p.places) : null,
              p.elevationProfile ? JSON.stringify(p.elevationProfile) : null,
              JSON.stringify(p),
            ],
          );
        }
      }
    } finally {
      client.release();
    }
  }

  private async batchInsertOutputLifts(
    features: OutputFeature[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const batchSize = 500;
      for (let i = 0; i < features.length; i += batchSize) {
        const batch = features.slice(i, i + batchSize);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        batch.forEach((feature, idx) => {
          const p = feature.properties;
          const numCols = 17;
          const offset = idx * numCols;
          placeholders.push(
            `($${offset + 1}, ST_Force3D(ST_GeomFromGeoJSON($${offset + 2})), $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17})`,
          );
          values.push(
            feature.feature_id,
            JSON.stringify(feature.geometry),
            toString(p.type),
            toString(p.name),
            toString(p.ref),
            toString(p.refFRCAIRN),
            toString(p.description),
            toString(p.liftType),
            toString(p.status),
            toBoolean(p.oneway),
            toInteger(p.occupancy),
            toInteger(p.capacity),
            toInteger(p.duration),
            toBoolean(p.bubble),
            toBoolean(p.heating),
            toBoolean(p.detachable),
            toTextArray(p.websites),
          );
        });

        await client.query(
          `INSERT INTO output.lifts (feature_id, geometry, type, name, ref, ref_fr_cairn, description, lift_type, status, oneway, occupancy, capacity, duration, bubble, heating, detachable, websites)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (feature_id) DO UPDATE SET
             geometry = EXCLUDED.geometry,
             type = EXCLUDED.type,
             name = EXCLUDED.name,
             ref = EXCLUDED.ref,
             ref_fr_cairn = EXCLUDED.ref_fr_cairn,
             description = EXCLUDED.description,
             lift_type = EXCLUDED.lift_type,
             status = EXCLUDED.status,
             oneway = EXCLUDED.oneway,
             occupancy = EXCLUDED.occupancy,
             capacity = EXCLUDED.capacity,
             duration = EXCLUDED.duration,
             bubble = EXCLUDED.bubble,
             heating = EXCLUDED.heating,
             detachable = EXCLUDED.detachable,
             websites = EXCLUDED.websites`,
          values,
        );

        // Update JSONB columns and full properties
        for (let j = 0; j < batch.length; j++) {
          const feature = batch[j];
          const p = feature.properties;
          await client.query(
            `UPDATE output.lifts SET
               wikidata_id = $2,
               ski_areas = $3,
               sources = $4,
               places = $5,
               properties = $6
             WHERE feature_id = $1`,
            [
              feature.feature_id,
              toString(p.wikidataID),
              p.skiAreas ? JSON.stringify(p.skiAreas) : null,
              p.sources ? JSON.stringify(p.sources) : null,
              p.places ? JSON.stringify(p.places) : null,
              JSON.stringify(p),
            ],
          );
        }
      }
    } finally {
      client.release();
    }
  }

  private async batchInsertOutputSkiAreas(
    features: OutputFeature[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const batchSize = 500;
      for (let i = 0; i < features.length; i += batchSize) {
        const batch = features.slice(i, i + batchSize);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        batch.forEach((feature, idx) => {
          const p = feature.properties;
          const numCols = 9;
          const offset = idx * numCols;
          placeholders.push(
            `($${offset + 1}, ST_Force3D(ST_GeomFromGeoJSON($${offset + 2})), $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`,
          );
          values.push(
            feature.feature_id,
            JSON.stringify(feature.geometry),
            toString(p.type),
            toString(p.name),
            toString(p.status),
            toTextArray(p.activities),
            toString(p.runConvention),
            toTextArray(p.websites),
            toString(p.wikidataID),
          );
        });

        await client.query(
          `INSERT INTO output.ski_areas (feature_id, geometry, type, name, status, activities, run_convention, websites, wikidata_id)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (feature_id) DO UPDATE SET
             geometry = EXCLUDED.geometry,
             type = EXCLUDED.type,
             name = EXCLUDED.name,
             status = EXCLUDED.status,
             activities = EXCLUDED.activities,
             run_convention = EXCLUDED.run_convention,
             websites = EXCLUDED.websites,
             wikidata_id = EXCLUDED.wikidata_id`,
          values,
        );

        // Update JSONB columns and full properties
        for (let j = 0; j < batch.length; j++) {
          const feature = batch[j];
          const p = feature.properties;
          await client.query(
            `UPDATE output.ski_areas SET
               sources = $2,
               places = $3,
               statistics = $4,
               properties = $5
             WHERE feature_id = $1`,
            [
              feature.feature_id,
              p.sources ? JSON.stringify(p.sources) : null,
              p.places ? JSON.stringify(p.places) : null,
              p.statistics ? JSON.stringify(p.statistics) : null,
              JSON.stringify(p),
            ],
          );
        }
      }
    } finally {
      client.release();
    }
  }

  private async batchInsertOutputHighways(
    features: OutputFeature[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const batchSize = 500;
      for (let i = 0; i < features.length; i += batchSize) {
        const batch = features.slice(i, i + batchSize);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        batch.forEach((feature, idx) => {
          const p = feature.properties;
          const numCols = 14;
          const offset = idx * numCols;
          placeholders.push(
            `($${offset + 1}, ST_Force3D(ST_GeomFromGeoJSON($${offset + 2})), $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14})`,
          );
          values.push(
            feature.feature_id,
            JSON.stringify(feature.geometry),
            toString(p.type),
            toString(p.name),
            toString(p.ref),
            toString(p.highwayType),
            toBoolean(p.isRoad),
            toBoolean(p.isWalkway),
            toBoolean(p.isPrivate),
            toString(p.surface),
            toString(p.smoothness),
            toBoolean(p.lit),
            toString(p.status),
            toTextArray(p.websites),
          );
        });

        await client.query(
          `INSERT INTO output.highways (feature_id, geometry, type, name, ref, highway_type, is_road, is_walkway, is_private, surface, smoothness, lit, status, websites)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (feature_id) DO UPDATE SET
             geometry = EXCLUDED.geometry,
             type = EXCLUDED.type,
             name = EXCLUDED.name,
             ref = EXCLUDED.ref,
             highway_type = EXCLUDED.highway_type,
             is_road = EXCLUDED.is_road,
             is_walkway = EXCLUDED.is_walkway,
             is_private = EXCLUDED.is_private,
             surface = EXCLUDED.surface,
             smoothness = EXCLUDED.smoothness,
             lit = EXCLUDED.lit,
             status = EXCLUDED.status,
             websites = EXCLUDED.websites`,
          values,
        );

        // Update JSONB columns and full properties
        for (let j = 0; j < batch.length; j++) {
          const feature = batch[j];
          const p = feature.properties;
          await client.query(
            `UPDATE output.highways SET
               wikidata_id = $2,
               ski_areas = $3,
               sources = $4,
               properties = $5
             WHERE feature_id = $1`,
            [
              feature.feature_id,
              toString(p.wikidataID),
              p.skiAreas ? JSON.stringify(p.skiAreas) : null,
              p.sources ? JSON.stringify(p.sources) : null,
              JSON.stringify(p),
            ],
          );
        }
      }
    } finally {
      client.release();
    }
  }

  private async *streamFeatures(
    tableName: string,
    source?: string,
  ): AsyncGenerator<GeoJSON.Feature> {
    const client = await this.pool.connect();
    try {
      const batchSize = 1000;
      let offset = 0;
      let hasMore = true;

      const whereClause = source ? `WHERE source = $3` : "";
      const params = source ? [batchSize, offset, source] : [batchSize, offset];

      while (hasMore) {
        const result = await client.query(
          `SELECT osm_id, osm_type, ST_AsGeoJSON(geometry)::jsonb as geometry, properties
           FROM ${tableName}
           ${whereClause}
           ORDER BY id
           LIMIT $1 OFFSET $2`,
          source ? [batchSize, offset, source] : [batchSize, offset],
        );

        for (const row of result.rows) {
          yield {
            type: "Feature",
            id: `${row.osm_type}/${row.osm_id}`,
            geometry: row.geometry,
            properties: {
              ...row.properties,
              id: row.osm_id,
              type: row.osm_type,
            },
          };
        }

        hasMore = result.rows.length === batchSize;
        offset += batchSize;
      }
    } finally {
      client.release();
    }
  }

  private async *streamOutputFeatures(
    tableName: string,
  ): AsyncGenerator<GeoJSON.Feature> {
    const client = await this.pool.connect();
    try {
      const batchSize = 1000;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const result = await client.query(
          `SELECT feature_id, ST_AsGeoJSON(geometry)::jsonb as geometry, properties
           FROM ${tableName}
           ORDER BY id
           LIMIT $1 OFFSET $2`,
          [batchSize, offset],
        );

        for (const row of result.rows) {
          yield {
            type: "Feature",
            id: row.feature_id,
            geometry: row.geometry,
            properties: row.properties,
          };
        }

        hasMore = result.rows.length === batchSize;
        offset += batchSize;
      }
    } finally {
      client.release();
    }
  }

  private async getCount(tableName: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM ${tableName}`,
    );
    return parseInt(result.rows[0].count, 10);
  }
}

let dataStoreInstance: PostGISDataStore | null = null;

export function getPostGISDataStore(config: PostgresConfig): PostGISDataStore {
  if (!dataStoreInstance) {
    dataStoreInstance = new PostGISDataStore(config);
  }
  return dataStoreInstance;
}

export async function closePostGISDataStore(): Promise<void> {
  if (dataStoreInstance) {
    await dataStoreInstance.close();
    dataStoreInstance = null;
  }
}
