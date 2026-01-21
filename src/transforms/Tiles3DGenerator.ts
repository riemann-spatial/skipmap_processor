import * as fs from "fs";
import * as path from "path";
import { performanceMonitor } from "../clustering/database/PerformanceMonitor";
import { Pool } from "pg";
import { PostgresConfig, Tiles3DConfig } from "../Config";
import { runCommand } from "../utils/ProcessRunner";
import { getPostgresPoolConfig } from "../utils/getPostgresPoolConfig";

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function dropTilesTableOrView(
  pool: Pool,
  schema: string,
  table: string,
): Promise<void> {
  const sql = `DO $$
DECLARE
  v_schema text := '${escapeLiteral(schema)}';
  v_table text := '${escapeLiteral(table)}';
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_schema
      AND c.relname = v_table
      AND c.relkind = 'v'
  ) THEN
    EXECUTE format('DROP VIEW %I.%I', v_schema, v_table);
  ELSIF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_schema
      AND c.relname = v_table
      AND c.relkind IN ('r', 'p', 'm')
  ) THEN
    EXECUTE format('DROP TABLE %I.%I', v_schema, v_table);
  END IF;
END $$;`;

  await pool.query(sql);
}

interface Layer3DConfig {
  name: string;
  table: string;
  geometryColumn: string;
  attributes: string[];
}

const LAYERS: Layer3DConfig[] = [
  {
    name: "runs",
    table: "output.runs",
    geometryColumn: "geometry",
    attributes: ["name", "difficulty", "status", "type", "ref", "grooming"],
  },
  {
    name: "lifts",
    table: "output.lifts",
    geometryColumn: "geometry",
    attributes: [
      "name",
      "lift_type",
      "status",
      "type",
      "ref",
      "occupancy",
      "capacity",
    ],
  },
  {
    name: "ski_areas",
    table: "output.ski_areas",
    geometryColumn: "geometry",
    attributes: ["name", "status", "type"],
  },
];

export async function generate3DTiles(
  postgresConfig: PostgresConfig,
  tiles3DConfig: Tiles3DConfig,
): Promise<void> {
  console.log("Generating 3D Tiles...");

  const pool = new Pool(
    getPostgresPoolConfig(postgresConfig.processingDatabase, postgresConfig),
  );

  // Ensure output directory exists
  if (!fs.existsSync(tiles3DConfig.outputDir)) {
    fs.mkdirSync(tiles3DConfig.outputDir, { recursive: true });
  }

  try {
    for (const layer of LAYERS) {
      await performanceMonitor.withOperation(
        `Generating 3D tiles for ${layer.name}`,
        async () => {
          const layerOutputDir = path.join(tiles3DConfig.outputDir, layer.name);

          // Ensure layer output directory exists
          if (!fs.existsSync(layerOutputDir)) {
            fs.mkdirSync(layerOutputDir, { recursive: true });
          }

          const [schema, table] = layer.table.split(".");
          const tilesTableName = `${schema}.${table}_3dtiles`;
          const geometryColumn = layer.geometryColumn;

          await dropTilesTableOrView(pool, schema, `${table}_3dtiles`);
          await pool.query(
            `CREATE TABLE ${tilesTableName} AS
             SELECT *
             FROM ${layer.table}
             WHERE ${geometryColumn} IS NOT NULL
               AND GeometryType(${geometryColumn}) NOT IN ('POINT', 'MULTIPOINT')`,
          );

          if (layer.name === "ski_areas") {
            // Ski areas may be GeometryCollections - extract only polygons
            await pool.query(
              `UPDATE ${tilesTableName}
               SET ${geometryColumn} = ST_CollectionExtract(
                 ST_MakeValid(${geometryColumn}),
                 3
               )`,
            );
          } else {
            // Runs and lifts - just make valid
            await pool.query(
              `UPDATE ${tilesTableName}
               SET ${geometryColumn} = ST_MakeValid(${geometryColumn})`,
            );
          }

          await pool.query(
            `DELETE FROM ${tilesTableName}
             WHERE ${geometryColumn} IS NULL
               OR ST_IsEmpty(${geometryColumn})
               OR NOT ST_IsValid(${geometryColumn})
               OR ST_Area(${geometryColumn}) = 0`,
          );

          // Remove geometries without valid Z coordinates
          // pg2b3dm requires Z values for 3D triangulation
          await pool.query(
            `DELETE FROM ${tilesTableName}
             WHERE NOT ST_CoordDim(${geometryColumn}) = 3
                OR ST_ZMin(${geometryColumn}) IS NULL
                OR (ST_ZMin(${geometryColumn}) = 0 AND ST_ZMax(${geometryColumn}) = 0)`,
          );

          if (layer.name === "ski_areas") {
            await pool.query(
              `DELETE FROM ${tilesTableName}
               WHERE GeometryType(${geometryColumn}) NOT IN ('POLYGON', 'MULTIPOLYGON')`,
            );
            // Remove degenerate polygons that would fail triangulation
            // (too few points or nearly collinear vertices)
            await pool.query(
              `DELETE FROM ${tilesTableName}
               WHERE ST_NPoints(${geometryColumn}) < 4
                  OR ST_Area(${geometryColumn}::geography) < 1`,
            );
          }

          const indexName = `idx_${schema}_${table}_3dtiles_geom`;
          await pool.query(
            `CREATE INDEX ${indexName}
             ON ${tilesTableName} USING gist(st_centroid(st_envelope(${geometryColumn})))`,
          );

          const countResult = await pool.query(
            `SELECT COUNT(*)::int AS count FROM ${tilesTableName}`,
          );
          const featureCount = countResult.rows[0]?.count ?? 0;
          if (featureCount === 0) {
            console.log(
              `Skipping 3D tiles for ${layer.name} (no non-point geometries)`,
            );
            await dropTilesTableOrView(pool, schema, `${table}_3dtiles`);
            return;
          }

          const args = [
            "-h",
            postgresConfig.host,
            "-p",
            postgresConfig.port.toString(),
            "-U",
            postgresConfig.user,
            "-d",
            postgresConfig.processingDatabase,
            "-t",
            tilesTableName,
            "-c",
            geometryColumn,
            "-o",
            layerOutputDir,
            "--use_implicit_tiling",
            "true",
          ];

          const env =
            postgresConfig.password !== undefined
              ? { ...process.env, PGPASSWORD: postgresConfig.password }
              : process.env;

          // Add attributes if specified
          if (layer.attributes.length > 0) {
            args.push("-a", layer.attributes.join(","));
          }

          await runCommand("pg2b3dm", args, { env });

          await dropTilesTableOrView(pool, schema, `${table}_3dtiles`);
        },
      );
    }
  } finally {
    await pool.end();
  }

  console.log("3D Tiles generation complete");
}
