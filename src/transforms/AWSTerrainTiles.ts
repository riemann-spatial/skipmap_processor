import { fromArrayBuffer } from "geotiff";

const TILE_SIZE = 512;
const DEFAULT_AWS_TERRAIN_ZOOM = 15;
const NODATA_VALUE = -32768;
const MIN_VALID_ELEVATION = -500;
const MAX_VALID_ELEVATION = 9000;

type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

interface TileCoordinate {
  originalIndex: number;
  lat: number;
  lng: number;
  // Fractional pixel coordinates for bilinear interpolation
  pixelX: number;
  pixelY: number;
}

export interface TileBatch {
  tileKey: string;
  url: string;
  coordinates: TileCoordinate[];
  interpolate: boolean;
}

/**
 * Convert WGS84 lat/lng to Web Mercator tile X/Y at given zoom level
 */
export function latLngToTileXY(
  lat: number,
  lng: number,
  zoom: number,
): { tileX: number; tileY: number } {
  const n = Math.pow(2, zoom);
  const tileX = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const tileY = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );

  // Clamp to valid range
  return {
    tileX: Math.max(0, Math.min(n - 1, tileX)),
    tileY: Math.max(0, Math.min(n - 1, tileY)),
  };
}

/**
 * Convert lat/lng to fractional pixel position within a tile at given zoom level.
 * Returns fractional coordinates for use with bilinear interpolation.
 */
export function latLngToPixelInTile(
  lat: number,
  lng: number,
  zoom: number,
  tileX: number,
  tileY: number,
): { pixelX: number; pixelY: number } {
  const n = Math.pow(2, zoom);

  // Calculate the exact position in tile coordinates (0-1 range within tile)
  const x = ((lng + 180) / 360) * n - tileX;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n -
    tileY;

  // Convert to fractional pixel coordinates (0-256 range for 256x256 tiles)
  // Keep as fractional for bilinear interpolation
  const pixelX = x * 256;
  const pixelY = y * 256;

  return {
    pixelX: Math.max(0, Math.min(255.999, pixelX)),
    pixelY: Math.max(0, Math.min(255.999, pixelY)),
  };
}

/**
 * Get the GeoTIFF parent tile coordinates.
 * AWS GeoTIFF tiles are 512x512 which covers 4 standard 256x256 tiles.
 * So we use z-1 coordinates and calculate which quadrant the point falls in.
 */
export function getGeoTiffTileCoords(
  tileX: number,
  tileY: number,
): {
  geoTiffX: number;
  geoTiffY: number;
  quadrantX: number;
  quadrantY: number;
} {
  const geoTiffX = Math.floor(tileX / 2);
  const geoTiffY = Math.floor(tileY / 2);
  const quadrantX = tileX % 2;
  const quadrantY = tileY % 2;

  return { geoTiffX, geoTiffY, quadrantX, quadrantY };
}

/**
 * Build the URL for a GeoTIFF tile
 */
function buildTileUrl(
  baseUrl: string,
  z: number,
  x: number,
  y: number,
): string {
  return `${baseUrl}/${z}/${x}/${y}.tif`;
}

/**
 * Group coordinates by tile for efficient batch fetching.
 * Coordinates that fall on the same tile are grouped together.
 */
export function batchCoordinatesByTile(
  coordinates: number[][],
  baseUrl: string,
  zoom: number,
  interpolate: boolean,
): TileBatch[] {
  const batches = new Map<string, TileBatch>();

  for (let i = 0; i < coordinates.length; i++) {
    const [lat, lng] = coordinates[i];
    const { tileX, tileY } = latLngToTileXY(lat, lng, zoom);
    const { geoTiffX, geoTiffY, quadrantX, quadrantY } = getGeoTiffTileCoords(
      tileX,
      tileY,
    );

    // GeoTIFF uses z-1 zoom level
    const geoTiffZ = zoom - 1;
    const tileKey = `${geoTiffZ}/${geoTiffX}/${geoTiffY}`;

    if (!batches.has(tileKey)) {
      batches.set(tileKey, {
        tileKey,
        url: buildTileUrl(baseUrl, geoTiffZ, geoTiffX, geoTiffY),
        coordinates: [],
        interpolate,
      });
    }

    // Calculate fractional pixel position within the 256x256 quadrant
    const { pixelX: basePixelX, pixelY: basePixelY } = latLngToPixelInTile(
      lat,
      lng,
      zoom,
      tileX,
      tileY,
    );

    // Offset by quadrant position within the 512x512 tile (keep fractional)
    const pixelX = quadrantX * 256 + basePixelX;
    const pixelY = quadrantY * 256 + basePixelY;

    batches.get(tileKey)!.coordinates.push({
      originalIndex: i,
      lat,
      lng,
      // Store fractional coordinates for bilinear interpolation
      pixelX: Math.max(0, Math.min(TILE_SIZE - 1.001, pixelX)),
      pixelY: Math.max(0, Math.min(TILE_SIZE - 1.001, pixelY)),
    });
  }

  return Array.from(batches.values());
}

/**
 * Check if an elevation value is valid (not nodata or out of range)
 */
function isValidElevation(elevation: number): boolean {
  return (
    elevation !== NODATA_VALUE &&
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
  elevationData: Int16Array | Float32Array | Float64Array,
  width: number,
  height: number,
  pixelX: number,
  pixelY: number,
): number | null {
  // Get integer coordinates of the four surrounding pixels
  const x0 = Math.floor(pixelX);
  const y0 = Math.floor(pixelY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);

  // Get fractional parts for weighting
  const xFrac = pixelX - x0;
  const yFrac = pixelY - y0;

  // Get elevation values at the four corners
  const e00 = elevationData[y0 * width + x0]; // top-left
  const e10 = elevationData[y0 * width + x1]; // top-right
  const e01 = elevationData[y1 * width + x0]; // bottom-left
  const e11 = elevationData[y1 * width + x1]; // bottom-right

  // Check if all four values are valid
  if (
    !isValidElevation(e00) ||
    !isValidElevation(e10) ||
    !isValidElevation(e01) ||
    !isValidElevation(e11)
  ) {
    return null;
  }

  // Bilinear interpolation formula:
  // f(x,y) = f(0,0)(1-x)(1-y) + f(1,0)x(1-y) + f(0,1)(1-x)y + f(1,1)xy
  const elevation =
    e00 * (1 - xFrac) * (1 - yFrac) +
    e10 * xFrac * (1 - yFrac) +
    e01 * (1 - xFrac) * yFrac +
    e11 * xFrac * yFrac;

  return elevation;
}

/**
 * Extract raw raster cell value without interpolation.
 * Uses the nearest pixel (floor of fractional coordinates).
 */
function extractRawCellValue(
  elevationData: Int16Array | Float32Array | Float64Array,
  width: number,
  pixelX: number,
  pixelY: number,
): number | null {
  const x = Math.floor(pixelX);
  const y = Math.floor(pixelY);
  const pixelIndex = y * width + x;
  const elevation = elevationData[pixelIndex];

  if (!isValidElevation(elevation)) {
    return null;
  }

  return elevation;
}

/**
 * Fetch a GeoTIFF tile and extract elevation values for all coordinates in the batch.
 * Uses bilinear interpolation if batch.interpolate is true, otherwise raw cell values.
 */
export async function fetchTileAndExtractElevations(
  batch: TileBatch,
): Promise<Result<Map<number, number | null>, string>> {
  try {
    const response = await fetch(batch.url, {
      headers: {
        "User-Agent":
          "openskidata-processor/1.0.0 (+https://github.com/russellporter/openskidata-processor)",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        // Tile doesn't exist (ocean, outside coverage)
        const results = new Map<number, number | null>();
        batch.coordinates.forEach((coord) =>
          results.set(coord.originalIndex, null),
        );
        return { ok: true, value: results };
      }
      return {
        ok: false,
        error: `HTTP ${response.status} for tile ${batch.tileKey}`,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const tiff = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const rasters = await image.readRasters();
    const elevationData = rasters[0] as
      | Int16Array
      | Float32Array
      | Float64Array;

    const width = image.getWidth();
    const height = image.getHeight();
    const results = new Map<number, number | null>();

    for (const coord of batch.coordinates) {
      let elevation: number | null;

      if (batch.interpolate) {
        // Use bilinear interpolation for accurate elevation at arbitrary coordinates
        elevation = bilinearInterpolate(
          elevationData,
          width,
          height,
          coord.pixelX,
          coord.pixelY,
        );
      } else {
        // Use raw raster cell value (nearest neighbor)
        elevation = extractRawCellValue(
          elevationData,
          width,
          coord.pixelX,
          coord.pixelY,
        );
      }

      results.set(coord.originalIndex, elevation);
    }

    return { ok: true, value: results };
  } catch (error) {
    return {
      ok: false,
      error: `Fetch error for tile ${batch.tileKey}: ${error}`,
    };
  }
}

/**
 * Fetch elevations for multiple coordinates from AWS Terrain Tiles GeoTIFF endpoint.
 * Coordinates are batched by tile to minimize HTTP requests.
 * @param interpolate - If true, use bilinear interpolation; if false, use raw raster cell values
 */
export async function fetchElevationsFromAWSTerrainTiles(
  coordinates: number[][],
  baseUrl: string,
  zoom: number = DEFAULT_AWS_TERRAIN_ZOOM,
  interpolate: boolean = true,
): Promise<Result<number | null, string>[]> {
  // Initialize results array
  const results: Result<number | null, string>[] = coordinates.map(() => ({
    ok: true,
    value: null,
  }));

  // Batch coordinates by tile
  const batches = batchCoordinatesByTile(
    coordinates,
    baseUrl,
    zoom,
    interpolate,
  );

  // Fetch all tiles in parallel with concurrency limit
  const CONCURRENCY_LIMIT = 10;

  for (let i = 0; i < batches.length; i += CONCURRENCY_LIMIT) {
    const batchSlice = batches.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batchSlice.map((batch) => fetchTileAndExtractElevations(batch)),
    );

    // Process results
    for (let j = 0; j < batchResults.length; j++) {
      const batchResult = batchResults[j];
      const batch = batchSlice[j];

      if (batchResult.ok) {
        for (const [originalIndex, elevation] of batchResult.value) {
          results[originalIndex] = { ok: true, value: elevation };
        }
      } else {
        // Mark all coordinates in this batch as errors
        for (const coord of batch.coordinates) {
          results[coord.originalIndex] = {
            ok: false,
            error: batchResult.error,
          };
        }
      }
    }
  }

  return results;
}

export { DEFAULT_AWS_TERRAIN_ZOOM };
