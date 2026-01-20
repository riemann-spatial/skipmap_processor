import { fromArrayBuffer } from "geotiff";
import { latLngToTileXY } from "./AWSTerrainTiles";

export const DEFAULT_WCS_ZOOM = 15;
export const DEFAULT_WCS_VERSION = "1.0.0";
export const DEFAULT_WCS_FORMAT = "GeoTIFF";
export const DEFAULT_WCS_CRS = "EPSG:4326";
export const DEFAULT_TILE_SIZE = 256;

// These defaults mirror the AWS terrain implementation; WCS datasets may differ,
// but keeping these guards avoids propagating obviously-bad values.
export const DEFAULT_NODATA_VALUE = -32768;
const MIN_VALID_ELEVATION = -500;
const MAX_VALID_ELEVATION = 9000;

/**
 * Determine the Austrian MGI Gauss-Krüger zone suffix based on longitude.
 * Used for Tirol WCS coverage IDs like "Gelaendemodell_5m_M28".
 *
 * Zones:
 * - M28: Central meridian 10.33°E (roughly 8.5°E to 12.5°E)
 * - M31: Central meridian 13.33°E (roughly 11.5°E to 15.5°E)
 * - M34: Central meridian 16.33°E (roughly 14.5°E to 18.5°E)
 */
function getMGIZoneSuffix(lng: number): string {
  // Midpoints between zone central meridians
  const m28_m31_boundary = 11.83; // (10.33 + 13.33) / 2
  const m31_m34_boundary = 14.83; // (13.33 + 16.33) / 2

  if (lng < m28_m31_boundary) {
    return "M28";
  } else if (lng < m31_m34_boundary) {
    return "M31";
  } else {
    return "M34";
  }
}

/**
 * Get the full coverage ID with zone suffix if the base ID ends with underscore.
 * E.g., "Gelaendemodell_5m_" + M28 = "Gelaendemodell_5m_M28"
 */
function getCoverageIdForCoordinate(baseCoverageId: string, lng: number): string {
  if (baseCoverageId.endsWith("_")) {
    return baseCoverageId + getMGIZoneSuffix(lng);
  }
  return baseCoverageId;
}

type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export type AxisOrder = "lonlat" | "latlon";
export const DEFAULT_WCS_AXIS_ORDER: AxisOrder = "lonlat";

interface TileCoordinate {
  originalIndex: number;
  lat: number;
  lng: number;
  // Fractional pixel coordinates in the fetched raster (for interpolation)
  pixelX: number;
  pixelY: number;
}

interface WCSBatch {
  tileKey: string;
  url: string;
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  width: number;
  height: number;
  interpolate: boolean;
  nodataValue: number;
  coordinates: TileCoordinate[];
}

function tileBoundsLonLat(zoom: number, x: number, y: number) {
  const n = Math.pow(2, zoom);
  const lonLeft = (x / n) * 360 - 180;
  const lonRight = ((x + 1) / n) * 360 - 180;

  const latRadTop = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latRadBottom = Math.atan(
    Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)),
  );
  const latTop = (latRadTop * 180) / Math.PI;
  const latBottom = (latRadBottom * 180) / Math.PI;

  return { minLon: lonLeft, minLat: latBottom, maxLon: lonRight, maxLat: latTop };
}

export function buildWCSGetCoverageURL(params: {
  baseUrl: string;
  coverageId: string;
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  width?: number;
  height?: number;
  version?: string;
  format?: string;
  crs?: string;
  axisOrder?: AxisOrder;
}): string {
  const {
    baseUrl,
    coverageId,
    bbox,
    width = DEFAULT_TILE_SIZE,
    height = DEFAULT_TILE_SIZE,
    version = DEFAULT_WCS_VERSION,
    format = DEFAULT_WCS_FORMAT,
    crs = DEFAULT_WCS_CRS,
    axisOrder = DEFAULT_WCS_AXIS_ORDER,
  } = params;

  // ArcGIS WCS supports WCS 1.0.0 in the provided capabilities. WCS 1.0.0 KVP uses:
  // service=WCS&request=GetCoverage&version=1.0.0&coverage=<id>&crs=EPSG:4326&bbox=minx,miny,maxx,maxy&format=image/tiff&width=256&height=256
  // NOTE: EPSG:4326 axis order is lat,lon in strict OGC terms, but many servers accept lon,lat.
  // We allow selecting the bbox axis order explicitly.
  const bboxStr =
    axisOrder === "latlon"
      ? `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`
      : `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`;

  const u = new URL(baseUrl);
  u.searchParams.set("service", "WCS");
  u.searchParams.set("request", "GetCoverage");
  u.searchParams.set("version", version);
  u.searchParams.set("coverage", coverageId);
  u.searchParams.set("crs", crs);
  u.searchParams.set("bbox", bboxStr);
  u.searchParams.set("format", format);
  u.searchParams.set("width", String(width));
  u.searchParams.set("height", String(height));

  return u.toString();
}

function isValidElevation(elevation: number, nodataValue: number): boolean {
  return (
    elevation !== nodataValue &&
    elevation >= MIN_VALID_ELEVATION &&
    elevation <= MAX_VALID_ELEVATION &&
    Number.isFinite(elevation)
  );
}

function bilinearInterpolate(
  elevationData: Int16Array | Float32Array | Float64Array,
  width: number,
  height: number,
  pixelX: number,
  pixelY: number,
  nodataValue: number,
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

function extractRawCellValue(
  elevationData: Int16Array | Float32Array | Float64Array,
  width: number,
  pixelX: number,
  pixelY: number,
  nodataValue: number,
): number | null {
  const x = Math.floor(pixelX);
  const y = Math.floor(pixelY);
  const elevation = elevationData[y * width + x];
  return isValidElevation(elevation, nodataValue) ? elevation : null;
}

function batchCoordinatesByWCSTile(
  coordinates: number[][],
  opts: {
    baseUrl: string;
    coverageId: string;
    zoom: number;
    interpolate: boolean;
    wcsVersion?: string;
    wcsFormat?: string;
    wcsCrs?: string;
    axisOrder?: AxisOrder;
    tileSize?: number;
    nodataValue?: number;
  },
): WCSBatch[] {
  const {
    baseUrl,
    coverageId,
    zoom,
    interpolate,
    wcsVersion,
    wcsFormat,
    wcsCrs,
    axisOrder,
    tileSize = DEFAULT_TILE_SIZE,
    nodataValue = DEFAULT_NODATA_VALUE,
  } = opts;

  const batches = new Map<string, WCSBatch>();

  for (let i = 0; i < coordinates.length; i++) {
    const [lat, lng] = coordinates[i];
    const { tileX, tileY } = latLngToTileXY(lat, lng, zoom);

    // Get the coverage ID for this coordinate (may include zone suffix)
    const resolvedCoverageId = getCoverageIdForCoordinate(coverageId, lng);

    // Include coverage ID in batch key to separate different zones
    const batchKey = `${resolvedCoverageId}/${zoom}/${tileX}/${tileY}`;

    if (!batches.has(batchKey)) {
      const bbox = tileBoundsLonLat(zoom, tileX, tileY);
      const url = buildWCSGetCoverageURL({
        baseUrl,
        coverageId: resolvedCoverageId,
        bbox,
        width: tileSize,
        height: tileSize,
        version: wcsVersion,
        format: wcsFormat,
        crs: wcsCrs,
        axisOrder,
      });

      batches.set(batchKey, {
        tileKey: batchKey,
        url,
        bbox,
        width: tileSize,
        height: tileSize,
        interpolate,
        nodataValue,
        coordinates: [],
      });
    }

    const batch = batches.get(batchKey)!;
    const { minLon, minLat, maxLon, maxLat } = batch.bbox;

    // Map lon/lat to pixel coordinates in the *requested raster* (which is in EPSG:4326 bbox).
    // X increases eastward. Y increases downward in raster space.
    const xFrac = (lng - minLon) / (maxLon - minLon);
    const yFrac = (maxLat - lat) / (maxLat - minLat);
    const pixelX = Math.max(0, Math.min(batch.width - 1.001, xFrac * (batch.width - 1)));
    const pixelY = Math.max(0, Math.min(batch.height - 1.001, yFrac * (batch.height - 1)));

    batch.coordinates.push({
      originalIndex: i,
      lat,
      lng,
      pixelX,
      pixelY,
    });
  }

  return Array.from(batches.values());
}

async function fetchWCSTileAndExtractElevations(
  batch: WCSBatch,
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
        const results = new Map<number, number | null>();
        batch.coordinates.forEach((coord) => results.set(coord.originalIndex, null));
        return { ok: true, value: results };
      }
      return { ok: false, error: `HTTP ${response.status} for WCS tile ${batch.tileKey}` };
    }

    const arrayBuffer = await response.arrayBuffer();
    const tiff = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const rasters = await image.readRasters();
    const elevationData = rasters[0] as Int16Array | Float32Array | Float64Array;

    const width = image.getWidth();
    const height = image.getHeight();
    const results = new Map<number, number | null>();

    for (const coord of batch.coordinates) {
      const elevation = batch.interpolate
        ? bilinearInterpolate(
            elevationData,
            width,
            height,
            coord.pixelX,
            coord.pixelY,
            batch.nodataValue,
          )
        : extractRawCellValue(
            elevationData,
            width,
            coord.pixelX,
            coord.pixelY,
            batch.nodataValue,
          );

      results.set(coord.originalIndex, elevation);
    }

    return { ok: true, value: results };
  } catch (error) {
    return { ok: false, error: `Fetch error for WCS tile ${batch.tileKey}: ${error}` };
  }
}

/**
 * Fetch elevations for multiple coordinates from a WCS endpoint by requesting GeoTIFF tiles via GetCoverage.
 *
 * This is intended for regional high-resolution datasets published as WCS. Coordinates are batched by
 * WebMercator tiles (at `zoom`) to keep requests bounded.
 */
export async function fetchElevationsFromWCSTerrainTiles(
  coordinates: number[][],
  opts: {
    baseUrl: string;
    coverageId: string;
    zoom?: number;
    interpolate?: boolean;
    wcsVersion?: string;
    wcsFormat?: string;
    wcsCrs?: string;
    axisOrder?: AxisOrder;
    tileSize?: number;
    nodataValue?: number;
  },
): Promise<Result<number | null, string>[]> {
  const {
    baseUrl,
    coverageId,
    zoom = DEFAULT_WCS_ZOOM,
    interpolate = true,
    wcsVersion,
    wcsFormat,
    wcsCrs,
    axisOrder,
    tileSize,
    nodataValue,
  } = opts;

  const results: Result<number | null, string>[] = coordinates.map(() => ({
    ok: true,
    value: null,
  }));

  const batches = batchCoordinatesByWCSTile(coordinates, {
    baseUrl,
    coverageId,
    zoom,
    interpolate,
    wcsVersion,
    wcsFormat,
    wcsCrs,
    axisOrder,
    tileSize,
    nodataValue,
  });

  const CONCURRENCY_LIMIT = 6;
  for (let i = 0; i < batches.length; i += CONCURRENCY_LIMIT) {
    const slice = batches.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      slice.map((batch) => fetchWCSTileAndExtractElevations(batch)),
    );

    for (let j = 0; j < batchResults.length; j++) {
      const batchResult = batchResults[j];
      const batch = slice[j];

      if (batchResult.ok) {
        for (const [originalIndex, elevation] of batchResult.value) {
          results[originalIndex] = { ok: true, value: elevation };
        }
      } else {
        for (const coord of batch.coordinates) {
          results[coord.originalIndex] = { ok: false, error: batchResult.error };
        }
      }
    }
  }

  return results;
}

