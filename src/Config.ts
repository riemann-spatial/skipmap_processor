import { assert } from "console";
import * as path from "path";
import {
  DEFAULT_NODATA_VALUE,
  DEFAULT_TILE_SIZE,
  DEFAULT_WCS_AXIS_ORDER,
  DEFAULT_WCS_CRS,
  DEFAULT_WCS_FORMAT,
  DEFAULT_WCS_VERSION,
} from "./transforms/WCSTerrainTiles";

export type GeocodingServerType = "photon" | "geocode-api";

export type GeocodingServerConfig = {
  url: string;
  type?: GeocodingServerType;
  // How long to cache geocoding results in milliseconds
  cacheTTL: number;
};

export type SnowCoverFetchPolicy = "full" | "incremental" | "none";

export type SnowCoverConfig = {
  fetchPolicy: SnowCoverFetchPolicy;
};

export type ElevationServerType =
  | "racemap"
  | "tileserver-gl"
  | "aws-terrain-tiles"
  | "wcs"
  | "local-dem";

// AWS Terrain Tiles - globally available, used as implicit fallback
export const AWS_TERRAIN_TILES_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/geotiff";

export type ElevationServerConfig = {
  url: string;
  type: ElevationServerType;
  zoom?: number[]; // Optional zoom levels for tileserver-gl - will be tried in order
  interpolate: boolean; // Use bilinear interpolation (true) or raw raster cell value (false)

  // WCS-specific configuration (used when type === "wcs")
  coverageId?: string;
  wcsVersion?: string;
  wcsFormat?: string;
  wcsCrs?: string;
  wcsAxisOrder?: "lonlat" | "latlon";
  wcsTileSize?: number;
  wcsNoDataValue?: number;

  // Local DEM configuration (used when type === "local-dem")
  localDemDirectory?: string;
};

export type TilesConfig = { mbTilesPath: string; tilesDir: string };

export type Tiles3DConfig = { outputDir: string };

export type PostgresConfig = {
  host: string;
  port: number;
  cacheDatabase: string;
  processingDatabase: string;
  user: string;
  password?: string;
  maxConnections: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  tablePrefix: string;
};

export type OutputConfig = {
  toFiles: boolean;
  toPostgis: boolean;
};

export interface Config {
  elevationServer: ElevationServerConfig | null;
  // Geocoder in https://github.com/komoot/photon format, disk cache TTL in milliseconds
  geocodingServer: GeocodingServerConfig | null;
  // GeoJSON format (https://geojson.org/geojson-spec.html#bounding-boxes)
  bbox: GeoJSON.BBox | null;
  // Directory used for downloads and storage of intermediate results
  workingDir: string;
  // Directory where the output files are written to
  outputDir: string;
  // Snow cover data integration
  snowCover: SnowCoverConfig | null;
  // Tiles generation configuration
  tiles: TilesConfig | null;
  // 3D Tiles generation configuration
  tiles3D: Tiles3DConfig | null;
  // PostgreSQL cache configuration
  postgresCache: PostgresConfig;
  // Output configuration
  output: OutputConfig;
  // Whether to add elevation data to geometries (default: true)
  conflateElevation: boolean;
  // Skip processing and jump straight to PostGIS export
  exportOnly: boolean;
}

export function configFromEnvironment(): Config {
  let bbox = null;
  if (process.env.BBOX) {
    bbox = JSON.parse(process.env.BBOX);
    assert(
      Array.isArray(bbox) &&
        bbox.length === 4 &&
        bbox.every((value) => typeof value === "number"),
    );
  }
  const geocodingCacheTTL = process.env.GEOCODING_SERVER_URL_TTL;
  const workingDir = process.env["WORKING_DIR"] ?? "data";

  // Validate snow cover fetch policy
  const snowCoverFetchPolicy = process.env.SNOW_COVER_FETCH_POLICY;
  if (
    snowCoverFetchPolicy &&
    !["full", "incremental", "none"].includes(snowCoverFetchPolicy)
  ) {
    throw new Error(
      `Invalid SNOW_COVER_FETCH_POLICY: ${snowCoverFetchPolicy}. Must be one of: full, incremental, none`,
    );
  }

  const outputDir = process.env["OUTPUT_DIR"] ?? "data";

  // Elevation is always enabled - AWS Terrain Tiles is the default
  const elevationServerType =
    (process.env["ELEVATION_SERVER_TYPE"] as ElevationServerType) ??
    "aws-terrain-tiles";
  const elevationServerURL =
    process.env["ELEVATION_SERVER_URL"] || AWS_TERRAIN_TILES_URL;
  const localDemDirectory = process.env["LOCAL_DEM_DIRECTORY"];

  // Disable elevation only if explicitly set to "none" or "disabled"
  const disableElevation =
    process.env["ELEVATION_SERVER_TYPE"] === "none" ||
    process.env["ELEVATION_SERVER_TYPE"] === "disabled";

  return {
    elevationServer: disableElevation
      ? null
      : {
          url: elevationServerURL,
          type: elevationServerType,
          zoom: process.env["ELEVATION_SERVER_ZOOM"]
            ? process.env["ELEVATION_SERVER_ZOOM"]
                .split(",")
                .map((z) => parseInt(z.trim()))
            : undefined,
          interpolate:
            process.env["INTERPOLATE_HEIGHT_INFORMATION"] !== "false",

          // WCS-specific (only used when ELEVATION_SERVER_TYPE=wcs)
          coverageId: process.env["ELEVATION_WCS_COVERAGE_ID"],
          wcsVersion:
            process.env["ELEVATION_WCS_VERSION"] ?? DEFAULT_WCS_VERSION,
          wcsFormat: process.env["ELEVATION_WCS_FORMAT"] ?? DEFAULT_WCS_FORMAT,
          wcsCrs: process.env["ELEVATION_WCS_CRS"] ?? DEFAULT_WCS_CRS,
          wcsAxisOrder:
            (process.env["ELEVATION_WCS_AXIS_ORDER"] as
              | "lonlat"
              | "latlon"
              | undefined) ?? DEFAULT_WCS_AXIS_ORDER,
          wcsTileSize: process.env["ELEVATION_WCS_TILE_SIZE"]
            ? parseInt(process.env["ELEVATION_WCS_TILE_SIZE"])
            : DEFAULT_TILE_SIZE,
          wcsNoDataValue: process.env["ELEVATION_WCS_NODATA_VALUE"]
            ? parseFloat(process.env["ELEVATION_WCS_NODATA_VALUE"])
            : DEFAULT_NODATA_VALUE,

          // Local DEM-specific (only used when ELEVATION_SERVER_TYPE=local-dem)
          localDemDirectory: localDemDirectory,
        },
    geocodingServer:
      process.env.GEOCODING_SERVER_URL !== undefined
        ? {
            url: process.env.GEOCODING_SERVER_URL,
            type:
              (process.env.GEOCODING_SERVER_TYPE as GeocodingServerType) ||
              "photon",
            cacheTTL:
              geocodingCacheTTL !== undefined
                ? Number.parseInt(geocodingCacheTTL)
                : 1000 * 60 * 60 * 24 * 365, // 1 year
          }
        : null,
    bbox: bbox as GeoJSON.BBox,
    workingDir: workingDir,
    outputDir: outputDir,
    snowCover:
      process.env.ENABLE_SNOW_COVER === "1"
        ? {
            fetchPolicy:
              (snowCoverFetchPolicy as SnowCoverFetchPolicy) ?? "full",
          }
        : null,
    tiles:
      process.env.GENERATE_MBTILES === "1"
        ? {
            mbTilesPath: path.join(outputDir, "openskimap.mbtiles"),
            tilesDir: path.join(outputDir, "openskimap"),
          }
        : null,
    tiles3D:
      process.env.GENERATE_3D_TILES === "1"
        ? {
            outputDir: path.join(outputDir, "3dtiles"),
          }
        : null,
    postgresCache: getPostgresConfig(),
    output: {
      toFiles: process.env.OUTPUT_TO_FILES !== "0",
      toPostgis: process.env.OUTPUT_TO_POSTGIS === "1",
    },
    conflateElevation: process.env.CONFLATE_ELEVATION !== "0",
    exportOnly: process.env.EXPORT_ONLY === "1",
  };
}

function getPostgresConfig(): PostgresConfig {
  const dbname = process.env.DBNAME || "openskidata";
  return {
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
    cacheDatabase: `${dbname}_cache`,
    processingDatabase: dbname,
    user: process.env.POSTGRES_USER || "postgres",
    password: process.env.POSTGRES_PASSWORD,
    maxConnections: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    tablePrefix: "",
  };
}

export function getPostgresTestConfig(): PostgresConfig {
  const testId = `test_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  return {
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
    cacheDatabase: "openskidata_test",
    processingDatabase: "openskidata_test",
    user: process.env.POSTGRES_USER || "postgres",
    password: process.env.POSTGRES_PASSWORD,
    maxConnections: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    tablePrefix: testId,
  };
}
