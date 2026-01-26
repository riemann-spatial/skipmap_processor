import DataLoader from "dataloader";
import * as geohash from "ngeohash";
import {
  extractPointsForElevationProfile,
  FeatureType,
  LiftFeature,
  RunFeature,
  SkiAreaFeature,
} from "openskidata-format";
import {
  AWS_TERRAIN_TILES_URL,
  ElevationServerConfig,
  PostgresConfig,
} from "../Config";
import { GeometryError } from "../errors";
import { fetchWithRetry } from "../utils/fetchWithRetry";
import { PostgresCache } from "../utils/PostgresCache";
import {
  DEFAULT_AWS_TERRAIN_ZOOM,
  fetchElevationsFromAWSTerrainTiles,
} from "./AWSTerrainTiles";
import {
  DEFAULT_TILE_SIZE,
  DEFAULT_WCS_ZOOM,
  fetchElevationsFromWCSTerrainTiles,
} from "./WCSTerrainTiles";
import { fetchElevationsFromLocalDEM } from "./LocalDEMTerrainTiles";

const DEFAULT_ELEVATION_PROFILE_RESOLUTION = 25;
const MIN_ELEVATION_PROFILE_RESOLUTION = 10;
const MAX_ELEVATION_PROFILE_RESOLUTION = 50;
const WEB_MERCATOR_INITIAL_RESOLUTION = 156543.03392; // meters/pixel at equator for 256px tiles
const ELEVATION_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const DEFAULT_TILESERVER_ZOOM = [12];
const ERROR_LOG_THROTTLE_MS = 60000; // Log unique errors at most once per minute

type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

class ThrottledLogger {
  private lastLoggedErrors: Map<string, number> = new Map();

  log(errorKey: string, logFn: () => void): void {
    const now = Date.now();
    const lastLogged = this.lastLoggedErrors.get(errorKey);

    if (!lastLogged || now - lastLogged > ERROR_LOG_THROTTLE_MS) {
      logFn();
      this.lastLoggedErrors.set(errorKey, now);
    }
  }
}

const throttledLogger = new ThrottledLogger();

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function averageLatitude(coordinates: number[][]): number | null {
  if (coordinates.length === 0) {
    return null;
  }
  const sum = coordinates.reduce((total, coord) => total + coord[1], 0);
  return sum / coordinates.length;
}

function metersPerPixelForZoom(
  zoom: number,
  latitude: number,
  tileSize = DEFAULT_TILE_SIZE,
): number {
  const latRad = (latitude * Math.PI) / 180;
  const baseResolution =
    (WEB_MERCATOR_INITIAL_RESOLUTION * Math.cos(latRad)) / Math.pow(2, zoom);
  return baseResolution * (DEFAULT_TILE_SIZE / tileSize);
}

function resolveElevationProfileResolution(
  elevationServerConfig: ElevationServerConfig,
  coordinates: number[][],
): number {
  const avgLat = averageLatitude(coordinates);
  if (avgLat === null) {
    return DEFAULT_ELEVATION_PROFILE_RESOLUTION;
  }

  switch (elevationServerConfig.type) {
    case "aws-terrain-tiles": {
      const zoom = elevationServerConfig.zoom?.[0] ?? DEFAULT_AWS_TERRAIN_ZOOM;
      const metersPerPixel = metersPerPixelForZoom(zoom, avgLat);
      return clampValue(
        Math.round(metersPerPixel),
        MIN_ELEVATION_PROFILE_RESOLUTION,
        MAX_ELEVATION_PROFILE_RESOLUTION,
      );
    }
    case "wcs": {
      const zoom = elevationServerConfig.zoom?.[0] ?? DEFAULT_WCS_ZOOM;
      const tileSize = elevationServerConfig.wcsTileSize ?? DEFAULT_TILE_SIZE;
      const metersPerPixel = metersPerPixelForZoom(zoom, avgLat, tileSize);
      return clampValue(
        Math.round(metersPerPixel),
        MIN_ELEVATION_PROFILE_RESOLUTION,
        MAX_ELEVATION_PROFILE_RESOLUTION,
      );
    }
    case "tileserver-gl": {
      const zoom =
        elevationServerConfig.zoom?.[0] ?? DEFAULT_TILESERVER_ZOOM[0];
      const metersPerPixel = metersPerPixelForZoom(zoom, avgLat);
      return clampValue(
        Math.round(metersPerPixel),
        MIN_ELEVATION_PROFILE_RESOLUTION,
        MAX_ELEVATION_PROFILE_RESOLUTION,
      );
    }
    case "local-dem":
      // Local DEM files typically have high resolution, use minimum profile resolution
      return MIN_ELEVATION_PROFILE_RESOLUTION;
    default:
      return DEFAULT_ELEVATION_PROFILE_RESOLUTION;
  }
}

export type ElevationFeature = RunFeature | LiftFeature | SkiAreaFeature;

export interface ElevationProcessor {
  processFeature: (feature: ElevationFeature) => Promise<ElevationFeature>;
  close: () => Promise<void>;
}

export interface ElevationProcessorOptions {
  clearCache?: boolean;
}

export async function createElevationProcessor(
  elevationServerConfig: ElevationServerConfig,
  postgresConfig: PostgresConfig,
  options: ElevationProcessorOptions = {},
): Promise<ElevationProcessor> {
  // IMPORTANT:
  // Cache keys are geohashes (lat/lng) only. If the elevation backend changes, or we toggle
  // interpolation mode, the numeric elevation at a coordinate can change. To avoid "sticky"
  // results where changing configuration appears to do nothing, namespace the cache table by
  // the server type + interpolation + zoom config.
  const typeSlug = elevationServerConfig.type.replace(/[^a-zA-Z0-9_]/g, "_");
  const zoomSuffix =
    elevationServerConfig.zoom && elevationServerConfig.zoom.length > 0
      ? `_z${elevationServerConfig.zoom.join("_")}`
      : "";
  const cacheType = `elevation_${typeSlug}_${
    elevationServerConfig.interpolate ? "interp" : "nearest"
  }${zoomSuffix}`.slice(0, 50); // keep table name comfortably under PG identifier limits

  const cache = new PostgresCache<number | null>(
    cacheType,
    postgresConfig,
    ELEVATION_CACHE_TTL_MS,
    { valueType: "REAL" },
  );
  await cache.initialize();

  if (options.clearCache) {
    console.log(`Clearing elevation cache table: ${cacheType}_cache`);
    await cache.clear();
  }

  const elevationLoader = new DataLoader<string, number | null>(
    async (geohashes: readonly string[]) => {
      return await batchLoadElevations(
        Array.from(geohashes),
        elevationServerConfig,
        cache,
      );
    },
    {
      batch: true,
      maxBatchSize: 1000,
    },
  );

  const processFeature = async (
    feature: ElevationFeature,
  ): Promise<ElevationFeature> => {
    const coordinates: number[][] = getCoordinates(feature);
    const geometry = feature.geometry;
    const elevationProfileResolution = resolveElevationProfileResolution(
      elevationServerConfig,
      coordinates,
    );
    const elevationProfileCoordinates: number[][] =
      geometry.type === "LineString"
        ? extractPointsForElevationProfile(geometry, elevationProfileResolution)
            .coordinates
        : [];

    // Generate geohash keys for all coordinates
    const allCoordinates = Array.from(coordinates).concat(
      elevationProfileCoordinates,
    );
    const geohashes = allCoordinates.map(
      ([lng, lat]) => geohash.encode(lat, lng, 10), // 10: +-1m accuracy
    );

    // Load elevations using DataLoader
    const elevationResults = await Promise.all(
      geohashes.map((hash) => elevationLoader.load(hash)),
    );

    // Process elevations, allowing nulls for missing data
    const elevations: (number | null)[] = elevationResults.map((elevation) =>
      elevation !== null ? roundElevation(elevation) : null,
    );

    const coordinateElevations = elevations.slice(0, coordinates.length);
    const profileElevations = elevations.slice(
      coordinates.length,
      elevations.length,
    );

    // Count missing elevations for logging
    const missingCoordCount = coordinateElevations.filter(
      (e) => e === null,
    ).length;
    const missingProfileCount = profileElevations.filter(
      (e) => e === null,
    ).length;

    if (missingCoordCount > 0 || missingProfileCount > 0) {
      const featureId = feature.properties.id || "unknown";
      const featureName = feature.properties.name || "unnamed";
      const featureType = feature.properties.type;
      const firstCoord = coordinates[0];
      console.warn(
        `Partial elevation data for ${featureType} "${featureName}" (id=${featureId}) ` +
          `at [${firstCoord?.[0]?.toFixed(5)}, ${firstCoord?.[1]?.toFixed(5)}]: ` +
          `${missingCoordCount}/${coordinateElevations.length} coordinates missing, ` +
          `${missingProfileCount}/${profileElevations.length} profile points missing`,
      );
    }

    // Only create elevation profile if ALL profile points have data
    if (feature.properties.type === FeatureType.Run) {
      const hasCompleteProfile =
        profileElevations.length > 0 && missingProfileCount === 0;
      feature.properties.elevationProfile = hasCompleteProfile
        ? {
            heights: profileElevations as number[],
            resolution: elevationProfileResolution,
          }
        : null;
    }

    // Add elevations to coordinates (skipping nulls)
    addElevations(feature, coordinateElevations);
    return feature;
  };

  const close = async (): Promise<void> => {
    await cache.close();
  };

  return {
    processFeature,
    close,
  };
}

async function batchLoadElevations(
  geohashes: string[],
  elevationServerConfig: ElevationServerConfig,
  cache: PostgresCache<number | null>,
): Promise<(number | null)[]> {
  const results: (number | null)[] = new Array(geohashes.length);
  const uncachedIndices: number[] = [];
  const uncachedCoordinates: number[][] = [];

  // Batch fetch from cache
  const cachedElevations = await cache.getMany(geohashes);

  // Identify uncached coordinates
  for (let i = 0; i < geohashes.length; i++) {
    const cachedElevation = cachedElevations[i];
    if (cachedElevation !== undefined) {
      results[i] = cachedElevation;
    } else {
      uncachedIndices.push(i);
      const decoded = geohash.decode(geohashes[i]);
      uncachedCoordinates.push([decoded.latitude, decoded.longitude]);
    }
  }

  // If all coordinates were cached, return results
  if (uncachedCoordinates.length === 0) {
    return results;
  }

  // Fetch elevations for uncached coordinates
  const fetchedElevations: Result<number | null, string>[] =
    await fetchElevationsFromServer(uncachedCoordinates, elevationServerConfig);

  if (uncachedCoordinates.length !== fetchedElevations.length) {
    throw new Error(
      "Number of uncached coordinates (" +
        uncachedCoordinates.length +
        ") is different than number of fetched elevations (" +
        fetchedElevations.length +
        ")",
    );
  }

  // Cache only successful non-null results
  const cacheEntries: Array<{ key: string; value: number }> = [];
  let errorCount = 0;

  for (let i = 0; i < uncachedIndices.length; i++) {
    const originalIndex = uncachedIndices[i];
    const result = fetchedElevations[i];
    const geohash = geohashes[originalIndex];

    if (result.ok) {
      results[originalIndex] = result.value;
      // Only cache non-null values to allow retry on next run
      if (result.value !== null) {
        cacheEntries.push({ key: geohash, value: result.value });
      }
    } else {
      // Don't cache errors, return null for this request
      errorCount++;
      throttledLogger.log(result.error, () => {
        console.warn(`Elevation fetch error: ${result.error}`);
      });
      results[originalIndex] = null;
    }
  }

  // Log summary if there were errors
  if (errorCount > 0) {
    throttledLogger.log("elevation-error-summary", () => {
      console.warn(
        `Failed to fetch elevation for ${errorCount} of ${fetchedElevations.length} coordinates`,
      );
    });
  }

  // Batch cache new elevations
  if (cacheEntries.length > 0) {
    await cache.setMany(cacheEntries);
  }

  return results;
}

async function fetchElevationsFromServer(
  coordinates: number[][],
  elevationServerConfig: ElevationServerConfig,
): Promise<Result<number | null, string>[]> {
  // Fetch from primary source
  const primaryResults = await fetchElevationsFromPrimarySource(
    coordinates,
    elevationServerConfig,
  );

  // AWS is the global fallback - skip if already using AWS
  if (elevationServerConfig.type === "aws-terrain-tiles") {
    return primaryResults;
  }

  // Find coordinates that need fallback (null values or errors)
  const needsFallback: { index: number; coords: number[] }[] = [];
  for (let i = 0; i < primaryResults.length; i++) {
    const result = primaryResults[i];
    if (!result.ok || result.value === null) {
      needsFallback.push({ index: i, coords: coordinates[i] });
    }
  }

  if (needsFallback.length === 0) {
    return primaryResults;
  }

  // Fetch missing elevations from AWS fallback
  const fallbackCoords = needsFallback.map((item) => item.coords);
  const fallbackResults = await fetchElevationsFromAWSTerrainTiles(
    fallbackCoords,
    AWS_TERRAIN_TILES_URL,
    DEFAULT_AWS_TERRAIN_ZOOM,
    elevationServerConfig.interpolate,
  );

  // Merge fallback results into primary results
  const mergedResults = [...primaryResults];
  for (let i = 0; i < needsFallback.length; i++) {
    const originalIndex = needsFallback[i].index;
    mergedResults[originalIndex] = fallbackResults[i];
  }

  return mergedResults;
}

async function fetchElevationsFromPrimarySource(
  coordinates: number[][],
  elevationServerConfig: ElevationServerConfig,
): Promise<Result<number | null, string>[]> {
  switch (elevationServerConfig.type) {
    case "racemap":
      return await fetchElevationsFromRacemap(
        coordinates,
        elevationServerConfig.url,
      );
    case "tileserver-gl":
      return await fetchElevationsFromTileserverGL(
        coordinates,
        elevationServerConfig.url,
        elevationServerConfig.zoom ?? DEFAULT_TILESERVER_ZOOM,
      );
    case "aws-terrain-tiles":
      return await fetchElevationsFromAWSTerrainTiles(
        coordinates,
        elevationServerConfig.url,
        elevationServerConfig.zoom?.[0] ?? DEFAULT_AWS_TERRAIN_ZOOM,
        elevationServerConfig.interpolate,
      );
    case "wcs":
      if (!elevationServerConfig.coverageId) {
        return coordinates.map(() => ({
          ok: false,
          error:
            "ELEVATION_SERVER_TYPE=wcs requires ELEVATION_WCS_COVERAGE_ID to be set (e.g. Gelaendemodell_5m_M28).",
        }));
      }
      return await fetchElevationsFromWCSTerrainTiles(coordinates, {
        baseUrl: elevationServerConfig.url,
        coverageId: elevationServerConfig.coverageId,
        zoom: elevationServerConfig.zoom?.[0] ?? DEFAULT_WCS_ZOOM,
        interpolate: elevationServerConfig.interpolate,
        wcsVersion: elevationServerConfig.wcsVersion,
        wcsFormat: elevationServerConfig.wcsFormat,
        wcsCrs: elevationServerConfig.wcsCrs,
        axisOrder: elevationServerConfig.wcsAxisOrder,
        tileSize: elevationServerConfig.wcsTileSize,
        nodataValue: elevationServerConfig.wcsNoDataValue,
      });
    case "local-dem":
      return await fetchElevationsFromLocalDEM(
        coordinates,
        elevationServerConfig,
      );
    default:
      const exhaustiveCheck: never = elevationServerConfig.type;
      throw new Error(`Unknown elevation server type: ${exhaustiveCheck}`);
  }
}

async function fetchElevationsFromRacemap(
  coordinates: number[][],
  elevationServerURL: string,
): Promise<Result<number | null, string>[]> {
  try {
    const response = await fetchWithRetry(elevationServerURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(coordinates),
    });

    if (!response.ok) {
      const error = `HTTP ${response.status} from Racemap elevation server`;
      return coordinates.map(() => ({ ok: false, error }));
    }

    const elevations: (number | null)[] = await response.json();
    return elevations.map((elevation) => ({ ok: true, value: elevation }));
  } catch (error) {
    const errorMessage = `Fetch error from Racemap: ${error}`;
    return coordinates.map(() => ({ ok: false, error: errorMessage }));
  }
}

async function fetchElevationsBatchFromTileserverGLAtZoom(
  coordinates: number[][],
  batchEndpointUrl: string,
  zoom: number,
): Promise<Result<(number | null)[], string>> {
  // Batch endpoint URL format: https://example.com/data/{id}/elevation
  try {
    // Convert coordinates from [lat, lng] to {lon, lat, z} format
    const points = coordinates.map(([lat, lng]) => ({
      lon: lng,
      lat: lat,
      z: zoom,
    }));

    const response = await fetchWithRetry(batchEndpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "openskidata-processor/1.0.0 (+https://github.com/russellporter/openskidata-processor)",
      },
      body: JSON.stringify({ points }),
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} at zoom ${zoom}` };
    }

    const elevations = await response.json();

    // Response should be an array of elevations (or null) in the same order
    if (
      !Array.isArray(elevations) ||
      elevations.length !== coordinates.length
    ) {
      return {
        ok: false,
        error: `Invalid batch response: expected array of ${coordinates.length} elevations`,
      };
    }

    return { ok: true, value: elevations };
  } catch (error) {
    return { ok: false, error: `Fetch error at zoom ${zoom}: ${error}` };
  }
}

async function fetchElevationsFromTileserverGL(
  coordinates: number[][],
  batchEndpointUrl: string,
  zooms: number[],
): Promise<Result<number | null, string>[]> {
  // Initialize results array with nulls
  const results: Result<number | null, string>[] = coordinates.map(() => ({
    ok: true,
    value: null,
  }));

  // Track which coordinates still need data
  let coordinatesNeedingData: Array<{ index: number; coords: number[] }> =
    coordinates.map((coords, index) => ({ index, coords }));

  // Try each zoom level in order, one request at a time
  for (const zoom of zooms) {
    if (coordinatesNeedingData.length === 0) {
      break; // All coordinates have data
    }

    // Batch fetch for all coordinates that still need data
    const coordsToFetch = coordinatesNeedingData.map((item) => item.coords);
    const batchResult = await fetchElevationsBatchFromTileserverGLAtZoom(
      coordsToFetch,
      batchEndpointUrl,
      zoom,
    );

    // If the batch request failed, mark all remaining coordinates as errors
    if (!batchResult.ok) {
      for (const { index } of coordinatesNeedingData) {
        results[index] = { ok: false, error: batchResult.error };
      }
      return results;
    }

    // Process batch results
    const newCoordinatesNeedingData: Array<{
      index: number;
      coords: number[];
    }> = [];

    for (let i = 0; i < coordinatesNeedingData.length; i++) {
      const { index } = coordinatesNeedingData[i];
      const elevation = batchResult.value[i];

      if (elevation !== null) {
        // Found data for this coordinate
        results[index] = { ok: true, value: elevation };
      } else {
        // No data at this zoom level, will try next zoom
        newCoordinatesNeedingData.push(coordinatesNeedingData[i]);
      }
    }

    coordinatesNeedingData = newCoordinatesNeedingData;
  }

  // Any remaining coordinates without data stay as null (ok: true, value: null)
  return results;
}

function getCoordinates(feature: ElevationFeature) {
  let coordinates: number[][];
  const geometryType = feature.geometry.type;
  switch (geometryType) {
    case "Point":
      coordinates = [feature.geometry.coordinates];
      break;
    case "LineString":
      coordinates = feature.geometry.coordinates;
      break;
    case "MultiLineString":
      coordinates = feature.geometry.coordinates.flat();
      break;
    case "Polygon":
      coordinates = feature.geometry.coordinates.flat();
      break;
    case "MultiPolygon":
      coordinates = feature.geometry.coordinates.flat(2);
      break;
    default:
      const exhaustiveCheck: never = geometryType;
      throw new GeometryError(
        `Geometry type ${exhaustiveCheck} not implemented`,
        exhaustiveCheck,
      );
  }

  // Remove elevation in case it was already added to this point
  return coordinates.map((coordinate) => [coordinate[0], coordinate[1]]);
}

function addElevations(
  feature: ElevationFeature,
  elevations: (number | null)[],
) {
  let i = 0;
  const geometryType = feature.geometry.type;
  switch (geometryType) {
    case "Point":
      addElevationToCoords(feature.geometry.coordinates, elevations[i]);
      return;
    case "LineString":
      return feature.geometry.coordinates.forEach((coords) => {
        addElevationToCoords(coords, elevations[i]);
        i++;
      });
    case "MultiLineString":
      return feature.geometry.coordinates.forEach((coordsSet) => {
        coordsSet.forEach((coords) => {
          addElevationToCoords(coords, elevations[i]);
          i++;
        });
      });
    case "Polygon":
      return feature.geometry.coordinates.forEach((coordsSet) => {
        coordsSet.forEach((coords) => {
          addElevationToCoords(coords, elevations[i]);
          i++;
        });
      });
    case "MultiPolygon":
      return feature.geometry.coordinates.forEach((polygon) => {
        polygon.forEach((ring) => {
          ring.forEach((coords) => {
            addElevationToCoords(coords, elevations[i]);
            i++;
          });
        });
      });
    default:
      const exhaustiveCheck: never = geometryType;
      throw new GeometryError(
        `Geometry type ${exhaustiveCheck} not implemented`,
        exhaustiveCheck,
      );
  }
}

function roundElevation(elevation: number): number {
  return Math.round(elevation * 10) / 10;
}

function addElevationToCoords(coords: number[], elevation: number | null) {
  if (coords.length === 3) {
    // The elevation was already added to this point (this can happen with polygons where the first and last coordinates are the same object in memory)
    return;
  }

  // Skip adding elevation if it's null (missing data)
  if (elevation === null) {
    return;
  }

  coords.push(elevation);
}
