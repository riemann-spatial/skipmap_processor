import { fromFile, GeoTIFFImage, TypedArray } from "geotiff";
import { ElevationServerConfig } from "../Config";
import { LocalDEMIndex } from "./LocalDEMIndex";

type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

const DEFAULT_NODATA_VALUE = -32768;
const MIN_VALID_ELEVATION = -500;
const MAX_VALID_ELEVATION = 9000;

interface CoordinateWithFile {
  originalIndex: number;
  lat: number;
  lng: number;
  filePath: string | null;
}

interface FileBatch {
  filePath: string;
  coordinates: CoordinateWithFile[];
}

// Module-level singleton index with caching by directory
let cachedIndex: LocalDEMIndex | null = null;
let cachedDirectory: string | null = null;

// Cache for open GeoTIFF files to avoid repeated file system access
const tiffCache = new Map<
  string,
  {
    image: GeoTIFFImage;
    rasterData: TypedArray;
    width: number;
    height: number;
    bbox: number[];
  }
>();

/**
 * Get or create a LocalDEMIndex for the given directory.
 */
async function getIndex(directory: string): Promise<LocalDEMIndex> {
  if (cachedIndex && cachedDirectory === directory) {
    return cachedIndex;
  }

  const index = new LocalDEMIndex(directory);
  await index.initialize();
  cachedIndex = index;
  cachedDirectory = directory;
  return index;
}

/**
 * Check if an elevation value is valid (not nodata or out of range)
 */
function isValidElevation(
  elevation: number,
  nodataValue: number = DEFAULT_NODATA_VALUE,
): boolean {
  return (
    elevation !== nodataValue &&
    elevation >= MIN_VALID_ELEVATION &&
    elevation <= MAX_VALID_ELEVATION &&
    Number.isFinite(elevation)
  );
}

/**
 * Perform bilinear interpolation on elevation data.
 * Uses the four surrounding pixels weighted by the fractional position.
 * Returns null if any of the four pixels have invalid data.
 */
function bilinearInterpolate(
  elevationData: TypedArray,
  width: number,
  height: number,
  pixelX: number,
  pixelY: number,
  nodataValue: number = DEFAULT_NODATA_VALUE,
): number | null {
  const x0 = Math.floor(pixelX);
  const y0 = Math.floor(pixelY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);

  const xFrac = pixelX - x0;
  const yFrac = pixelY - y0;

  const e00 = elevationData[y0 * width + x0];
  const e10 = elevationData[y0 * width + x1];
  const e01 = elevationData[y1 * width + x0];
  const e11 = elevationData[y1 * width + x1];

  if (
    !isValidElevation(e00, nodataValue) ||
    !isValidElevation(e10, nodataValue) ||
    !isValidElevation(e01, nodataValue) ||
    !isValidElevation(e11, nodataValue)
  ) {
    return null;
  }

  return (
    e00 * (1 - xFrac) * (1 - yFrac) +
    e10 * xFrac * (1 - yFrac) +
    e01 * (1 - xFrac) * yFrac +
    e11 * xFrac * yFrac
  );
}

/**
 * Extract raw raster cell value without interpolation.
 */
function extractRawCellValue(
  elevationData: TypedArray,
  width: number,
  pixelX: number,
  pixelY: number,
  nodataValue: number = DEFAULT_NODATA_VALUE,
): number | null {
  const x = Math.floor(pixelX);
  const y = Math.floor(pixelY);
  const elevation = elevationData[y * width + x];

  if (!isValidElevation(elevation, nodataValue)) {
    return null;
  }

  return elevation;
}

/**
 * Convert geographic coordinate to pixel position in a GeoTIFF image.
 */
function coordToPixel(
  lng: number,
  lat: number,
  bbox: number[],
  width: number,
  height: number,
): { pixelX: number; pixelY: number } {
  const [minLng, minLat, maxLng, maxLat] = bbox;

  // Calculate fractional pixel position
  const pixelX = ((lng - minLng) / (maxLng - minLng)) * width;
  // Note: GeoTIFF rows typically go from top (maxLat) to bottom (minLat)
  const pixelY = ((maxLat - lat) / (maxLat - minLat)) * height;

  return {
    pixelX: Math.max(0, Math.min(width - 1.001, pixelX)),
    pixelY: Math.max(0, Math.min(height - 1.001, pixelY)),
  };
}

/**
 * Get or load a GeoTIFF file's data from cache.
 */
async function getTiffData(filePath: string): Promise<{
  image: GeoTIFFImage;
  rasterData: TypedArray;
  width: number;
  height: number;
  bbox: number[];
}> {
  if (tiffCache.has(filePath)) {
    return tiffCache.get(filePath)!;
  }

  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();
  const rasters = await image.readRasters();
  const rasterData = rasters[0] as TypedArray;
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox();

  const data = { image, rasterData, width, height, bbox };
  tiffCache.set(filePath, data);
  return data;
}

/**
 * Fetch elevations from a single DEM file for a batch of coordinates.
 */
async function fetchElevationsFromFile(
  batch: FileBatch,
  interpolate: boolean,
): Promise<Map<number, Result<number | null, string>>> {
  const results = new Map<number, Result<number | null, string>>();

  try {
    const { rasterData, width, height, bbox } = await getTiffData(
      batch.filePath,
    );

    for (const coord of batch.coordinates) {
      const { pixelX, pixelY } = coordToPixel(
        coord.lng,
        coord.lat,
        bbox,
        width,
        height,
      );

      let elevation: number | null;
      if (interpolate) {
        elevation = bilinearInterpolate(
          rasterData,
          width,
          height,
          pixelX,
          pixelY,
        );
      } else {
        elevation = extractRawCellValue(rasterData, width, pixelX, pixelY);
      }

      results.set(coord.originalIndex, { ok: true, value: elevation });
    }
  } catch (error) {
    for (const coord of batch.coordinates) {
      results.set(coord.originalIndex, {
        ok: false,
        error: `Error reading ${batch.filePath}: ${error}`,
      });
    }
  }

  return results;
}

/**
 * Fetch elevations from local DEM files.
 * Returns null for coordinates outside local DEM coverage (fallback handled by Elevation.ts).
 */
export async function fetchElevationsFromLocalDEM(
  coordinates: number[][],
  config: ElevationServerConfig,
): Promise<Result<number | null, string>[]> {
  const directory = config.localDemDirectory;
  if (!directory) {
    return coordinates.map(() => ({
      ok: false,
      error: "LOCAL_DEM_DIRECTORY not configured",
    }));
  }

  const results: Result<number | null, string>[] = coordinates.map(() => ({
    ok: true,
    value: null,
  }));

  const index = await getIndex(directory);

  // Classify coordinates by file
  const coordinatesWithFiles: CoordinateWithFile[] = coordinates.map(
    ([lat, lng], i) => ({
      originalIndex: i,
      lat,
      lng,
      filePath: index.findFileForCoordinate(lng, lat),
    }),
  );

  // Group by file
  const fileBatches = new Map<string, FileBatch>();
  const coordinatesOutsideCoverage: CoordinateWithFile[] = [];

  for (const coord of coordinatesWithFiles) {
    if (coord.filePath) {
      if (!fileBatches.has(coord.filePath)) {
        fileBatches.set(coord.filePath, {
          filePath: coord.filePath,
          coordinates: [],
        });
      }
      fileBatches.get(coord.filePath)!.coordinates.push(coord);
    } else {
      coordinatesOutsideCoverage.push(coord);
    }
  }

  // Fetch from local DEM files in parallel
  const batchPromises = Array.from(fileBatches.values()).map((batch) =>
    fetchElevationsFromFile(batch, config.interpolate),
  );
  const batchResults = await Promise.all(batchPromises);

  // Merge results from local DEM files
  for (const batchResult of batchResults) {
    for (const [originalIndex, result] of batchResult) {
      results[originalIndex] = result;
    }
  }

  // Coordinates outside coverage remain as null - fallback handled by Elevation.ts
  return results;
}

/**
 * Clear the cached index and TIF data (useful for testing).
 */
export function clearLocalDEMCache(): void {
  cachedIndex = null;
  cachedDirectory = null;
  tiffCache.clear();
}
