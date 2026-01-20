#!/usr/bin/env npx tsx
/**
 * WCS Elevation Fetching Test Tool
 *
 * Usage:
 *   npx tsx test-wcs.ts --url <WCS_BASE_URL> --coverage <COVERAGE_ID> [options]
 *
 * Options:
 *   --url         WCS server base URL (required)
 *   --coverage    Coverage/layer ID (required). If ends with "_", zone suffix is auto-appended
 *   --lat         Latitude to test (default: 47.0)
 *   --lng         Longitude to test (default: 11.0)
 *   --zoom        Tile zoom level (default: 15)
 *   --version     WCS version (default: 1.0.0)
 *   --format      WCS format (default: GeoTIFF)
 *   --crs         CRS (default: EPSG:4326)
 *   --axis-order  Axis order: lonlat or latlon (default: lonlat)
 *   --tile-size   Tile size in pixels (default: 256)
 *   --nodata      Nodata value (default: -32768)
 *   --interpolate Enable bilinear interpolation (default: true)
 *   --debug       Enable debug output
 *   --save-tiff   Save fetched GeoTIFF to file for inspection
 *
 * Example (Tirol terrain with explicit coverage):
 *   npx tsx test-wcs.ts \
 *     --url "https://gis.tirol.gv.at/arcgis/services/Service_Public/terrain/MapServer/WCSServer" \
 *     --coverage "Gelaendemodell_5m_M28" \
 *     --lat 47.2 --lng 11.4 \
 *     --debug
 *
 * Example (Tirol terrain with auto zone suffix):
 *   npx tsx test-wcs.ts \
 *     --url "https://gis.tirol.gv.at/arcgis/services/Service_Public/terrain/MapServer/WCSServer" \
 *     --coverage "Gelaendemodell_5m_" \
 *     --lat 47.2 --lng 11.4 \
 *     --debug
 */

import { fromArrayBuffer } from "geotiff";
import * as fs from "fs";

// ============================================================================
// Types
// ============================================================================

type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
type AxisOrder = "lonlat" | "latlon";

interface TileCoordinate {
  originalIndex: number;
  lat: number;
  lng: number;
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

interface WCSConfig {
  baseUrl: string;
  coverageId: string;
  zoom: number;
  interpolate: boolean;
  wcsVersion: string;
  wcsFormat: string;
  wcsCrs: string;
  axisOrder: AxisOrder;
  tileSize: number;
  nodataValue: number;
  debug: boolean;
  saveTiff: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_WCS_ZOOM = 15;
const DEFAULT_WCS_VERSION = "1.0.0";
const DEFAULT_WCS_FORMAT = "GeoTIFF";
const DEFAULT_WCS_CRS = "EPSG:4326";
const DEFAULT_TILE_SIZE = 256;
const DEFAULT_NODATA_VALUE = -32768;
const MIN_VALID_ELEVATION = -500;
const MAX_VALID_ELEVATION = 9000;

/**
 * Determine the Austrian MGI Gauss-Krüger zone suffix based on longitude.
 * Used for Tirol WCS coverage IDs like "Gelaendemodell_5m_M28".
 */
function getMGIZoneSuffix(lng: number): string {
  const m28_m31_boundary = 11.83;
  const m31_m34_boundary = 14.83;

  if (lng < m28_m31_boundary) {
    return "M28";
  } else if (lng < m31_m34_boundary) {
    return "M31";
  } else {
    return "M34";
  }
}

function getCoverageIdForCoordinate(baseCoverageId: string, lng: number): string {
  if (baseCoverageId.endsWith("_")) {
    return baseCoverageId + getMGIZoneSuffix(lng);
  }
  return baseCoverageId;
}

// ============================================================================
// Utility Functions (from AWSTerrainTiles)
// ============================================================================

function latLngToTileXY(
  lat: number,
  lng: number,
  zoom: number
): { tileX: number; tileY: number } {
  const n = Math.pow(2, zoom);
  const tileX = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const tileY = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );

  return {
    tileX: Math.max(0, Math.min(n - 1, tileX)),
    tileY: Math.max(0, Math.min(n - 1, tileY)),
  };
}

// ============================================================================
// WCS Functions
// ============================================================================

function tileBoundsLonLat(zoom: number, x: number, y: number) {
  const n = Math.pow(2, zoom);
  const lonLeft = (x / n) * 360 - 180;
  const lonRight = ((x + 1) / n) * 360 - 180;

  const latRadTop = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latRadBottom = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  const latTop = (latRadTop * 180) / Math.PI;
  const latBottom = (latRadBottom * 180) / Math.PI;

  return {
    minLon: lonLeft,
    minLat: latBottom,
    maxLon: lonRight,
    maxLat: latTop,
  };
}

function buildWCSGetCoverageURL(params: {
  baseUrl: string;
  coverageId: string;
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  width: number;
  height: number;
  version: string;
  format: string;
  crs: string;
  axisOrder: AxisOrder;
}): string {
  const {
    baseUrl,
    coverageId,
    bbox,
    width,
    height,
    version,
    format,
    crs,
    axisOrder,
  } = params;

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
  nodataValue: number
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
  nodataValue: number
): number | null {
  const x = Math.floor(pixelX);
  const y = Math.floor(pixelY);
  const elevation = elevationData[y * width + x];
  return isValidElevation(elevation, nodataValue) ? elevation : null;
}

function createWCSBatch(
  lat: number,
  lng: number,
  config: WCSConfig
): WCSBatch {
  const { tileX, tileY } = latLngToTileXY(lat, lng, config.zoom);
  const bbox = tileBoundsLonLat(config.zoom, tileX, tileY);

  // Resolve coverage ID with zone suffix if needed
  const resolvedCoverageId = getCoverageIdForCoordinate(config.coverageId, lng);
  const tileKey = `${resolvedCoverageId}/${config.zoom}/${tileX}/${tileY}`;

  const url = buildWCSGetCoverageURL({
    baseUrl: config.baseUrl,
    coverageId: resolvedCoverageId,
    bbox,
    width: config.tileSize,
    height: config.tileSize,
    version: config.wcsVersion,
    format: config.wcsFormat,
    crs: config.wcsCrs,
    axisOrder: config.axisOrder,
  });

  // Map lon/lat to pixel coordinates
  const xFrac = (lng - bbox.minLon) / (bbox.maxLon - bbox.minLon);
  const yFrac = (bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat);
  const pixelX = Math.max(
    0,
    Math.min(config.tileSize - 1.001, xFrac * (config.tileSize - 1))
  );
  const pixelY = Math.max(
    0,
    Math.min(config.tileSize - 1.001, yFrac * (config.tileSize - 1))
  );

  return {
    tileKey,
    url,
    bbox,
    width: config.tileSize,
    height: config.tileSize,
    interpolate: config.interpolate,
    nodataValue: config.nodataValue,
    coordinates: [
      {
        originalIndex: 0,
        lat,
        lng,
        pixelX,
        pixelY,
      },
    ],
  };
}

async function fetchAndAnalyzeWCSTile(
  batch: WCSBatch,
  config: WCSConfig
): Promise<void> {
  console.log("\n" + "=".repeat(70));
  console.log("WCS ELEVATION FETCH TEST");
  console.log("=".repeat(70));

  const coord = batch.coordinates[0];
  console.log(`\nTest coordinate: lat=${coord.lat}, lng=${coord.lng}`);
  console.log(`Tile key: ${batch.tileKey}`);
  console.log(`\nBounding box:`);
  console.log(`  minLon: ${batch.bbox.minLon}`);
  console.log(`  minLat: ${batch.bbox.minLat}`);
  console.log(`  maxLon: ${batch.bbox.maxLon}`);
  console.log(`  maxLat: ${batch.bbox.maxLat}`);
  console.log(`\nPixel coordinates: x=${coord.pixelX.toFixed(3)}, y=${coord.pixelY.toFixed(3)}`);
  console.log(`\nWCS URL:\n${batch.url}`);

  console.log("\n" + "-".repeat(70));
  console.log("Fetching tile...");

  try {
    const startTime = Date.now();
    const response = await fetch(batch.url, {
      headers: {
        "User-Agent": "wcs-test-tool/1.0.0",
      },
    });

    const fetchTime = Date.now() - startTime;
    console.log(`Fetch completed in ${fetchTime}ms`);
    console.log(`HTTP Status: ${response.status} ${response.statusText}`);
    console.log(`Content-Type: ${response.headers.get("content-type")}`);
    console.log(`Content-Length: ${response.headers.get("content-length")} bytes`);

    if (!response.ok) {
      console.error(`\nERROR: HTTP ${response.status}`);
      const text = await response.text();
      console.error("Response body:");
      console.error(text.slice(0, 2000));
      return;
    }

    const arrayBuffer = await response.arrayBuffer();
    console.log(`\nReceived ${arrayBuffer.byteLength} bytes`);

    if (config.saveTiff) {
      const filename = `wcs_tile_${batch.tileKey.replace(/\//g, "_")}.tif`;
      fs.writeFileSync(filename, Buffer.from(arrayBuffer));
      console.log(`Saved GeoTIFF to: ${filename}`);
    }

    console.log("\n" + "-".repeat(70));
    console.log("Parsing GeoTIFF...");

    const tiff = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();

    const width = image.getWidth();
    const height = image.getHeight();
    const samplesPerPixel = image.getSamplesPerPixel();
    const bitsPerSample = image.getBitsPerSample();
    const sampleFormat = image.getSampleFormat();

    console.log(`\nImage properties:`);
    console.log(`  Width: ${width}`);
    console.log(`  Height: ${height}`);
    console.log(`  Samples per pixel: ${samplesPerPixel}`);
    console.log(`  Bits per sample: ${bitsPerSample}`);
    console.log(`  Sample format: ${sampleFormat}`);

    // Try to get GeoTIFF metadata
    try {
      const geoKeys = image.getGeoKeys();
      if (config.debug && geoKeys) {
        console.log(`\nGeoKeys:`, JSON.stringify(geoKeys, null, 2));
      }
    } catch {
      console.log(`  (No GeoKeys available)`);
    }

    try {
      const origin = image.getOrigin();
      const resolution = image.getResolution();
      console.log(`  Origin: [${origin}]`);
      console.log(`  Resolution: [${resolution}]`);
    } catch {
      console.log(`  (No origin/resolution available)`);
    }

    console.log("\n" + "-".repeat(70));
    console.log("Reading raster data...");

    const rasters = await image.readRasters();
    const elevationData = rasters[0] as Int16Array | Float32Array | Float64Array;

    console.log(`  Data type: ${elevationData.constructor.name}`);
    console.log(`  Data length: ${elevationData.length} values`);

    // Compute statistics
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let validCount = 0;
    let nodataCount = 0;

    for (let i = 0; i < elevationData.length; i++) {
      const val = elevationData[i];
      if (isValidElevation(val, batch.nodataValue)) {
        min = Math.min(min, val);
        max = Math.max(max, val);
        sum += val;
        validCount++;
      } else {
        nodataCount++;
      }
    }

    console.log(`\nRaster statistics:`);
    console.log(`  Valid values: ${validCount}`);
    console.log(`  Nodata values: ${nodataCount}`);
    if (validCount > 0) {
      console.log(`  Min elevation: ${min.toFixed(2)}m`);
      console.log(`  Max elevation: ${max.toFixed(2)}m`);
      console.log(`  Mean elevation: ${(sum / validCount).toFixed(2)}m`);
    }

    // Sample some values around the target pixel
    if (config.debug) {
      console.log(`\nSample values around target pixel (${Math.floor(coord.pixelX)}, ${Math.floor(coord.pixelY)}):`);
      const cx = Math.floor(coord.pixelX);
      const cy = Math.floor(coord.pixelY);
      for (let dy = -2; dy <= 2; dy++) {
        let row = "  ";
        for (let dx = -2; dx <= 2; dx++) {
          const px = cx + dx;
          const py = cy + dy;
          if (px >= 0 && px < width && py >= 0 && py < height) {
            const val = elevationData[py * width + px];
            row += `${val.toFixed(0).padStart(6)} `;
          } else {
            row += "   --- ";
          }
        }
        console.log(row);
      }
    }

    console.log("\n" + "-".repeat(70));
    console.log("Extracting elevation at target coordinate...");

    // Extract elevation
    let elevation: number | null;
    if (batch.interpolate) {
      console.log("  Method: Bilinear interpolation");
      elevation = bilinearInterpolate(
        elevationData,
        width,
        height,
        coord.pixelX,
        coord.pixelY,
        batch.nodataValue
      );
    } else {
      console.log("  Method: Nearest neighbor (raw cell value)");
      elevation = extractRawCellValue(
        elevationData,
        width,
        coord.pixelX,
        coord.pixelY,
        batch.nodataValue
      );
    }

    console.log("\n" + "=".repeat(70));
    if (elevation !== null) {
      console.log(`RESULT: Elevation = ${elevation.toFixed(2)} meters`);
    } else {
      console.log(`RESULT: No valid elevation data at this location`);

      // Debug why it failed
      const x = Math.floor(coord.pixelX);
      const y = Math.floor(coord.pixelY);
      const rawValue = elevationData[y * width + x];
      console.log(`  Raw pixel value: ${rawValue}`);
      console.log(`  Nodata value: ${batch.nodataValue}`);
      console.log(`  Is nodata: ${rawValue === batch.nodataValue}`);
      console.log(`  In valid range [${MIN_VALID_ELEVATION}, ${MAX_VALID_ELEVATION}]: ${rawValue >= MIN_VALID_ELEVATION && rawValue <= MAX_VALID_ELEVATION}`);
    }
    console.log("=".repeat(70) + "\n");
  } catch (error) {
    console.error("\nERROR:", error);
  }
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): { config: WCSConfig; lat: number; lng: number } | null {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(`
WCS Elevation Fetching Test Tool

Usage:
  npx tsx test-wcs.ts --url <WCS_BASE_URL> --coverage <COVERAGE_ID> [options]

Required:
  --url         WCS server base URL
  --coverage    Coverage/layer ID. If ends with "_", MGI zone suffix (M28/M31/M34) is auto-appended

Options:
  --lat         Latitude to test (default: 47.0)
  --lng         Longitude to test (default: 11.0)
  --zoom        Tile zoom level (default: 15)
  --version     WCS version (default: 1.0.0)
  --format      WCS format (default: GeoTIFF)
  --crs         CRS (default: EPSG:4326)
  --axis-order  Axis order: lonlat or latlon (default: lonlat)
  --tile-size   Tile size in pixels (default: 256)
  --nodata      Nodata value (default: -32768)
  --no-interpolate  Disable bilinear interpolation
  --debug       Enable debug output
  --save-tiff   Save fetched GeoTIFF to file for inspection

Example (explicit coverage):
  npx tsx test-wcs.ts \\
    --url "https://gis.tirol.gv.at/arcgis/services/Service_Public/terrain/MapServer/WCSServer" \\
    --coverage "Gelaendemodell_5m_M28" \\
    --lat 47.2 --lng 11.4 \\
    --debug

Example (auto zone suffix):
  npx tsx test-wcs.ts \\
    --url "https://gis.tirol.gv.at/arcgis/services/Service_Public/terrain/MapServer/WCSServer" \\
    --coverage "Gelaendemodell_5m_" \\
    --lat 47.2 --lng 11.4 \\
    --debug
`);
    return null;
  }

  function getArg(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return undefined;
  }

  function hasFlag(name: string): boolean {
    return args.includes(name);
  }

  const url = getArg("--url");
  const coverage = getArg("--coverage");

  if (!url) {
    console.error("Error: --url is required");
    return null;
  }

  if (!coverage) {
    console.error("Error: --coverage is required");
    return null;
  }

  return {
    config: {
      baseUrl: url,
      coverageId: coverage,
      zoom: parseInt(getArg("--zoom") || String(DEFAULT_WCS_ZOOM)),
      interpolate: !hasFlag("--no-interpolate"),
      wcsVersion: getArg("--version") || DEFAULT_WCS_VERSION,
      wcsFormat: getArg("--format") || DEFAULT_WCS_FORMAT,
      wcsCrs: getArg("--crs") || DEFAULT_WCS_CRS,
      axisOrder: (getArg("--axis-order") as AxisOrder) || "lonlat",
      tileSize: parseInt(getArg("--tile-size") || String(DEFAULT_TILE_SIZE)),
      nodataValue: parseFloat(getArg("--nodata") || String(DEFAULT_NODATA_VALUE)),
      debug: hasFlag("--debug"),
      saveTiff: hasFlag("--save-tiff"),
    },
    lat: parseFloat(getArg("--lat") || "47.0"),
    lng: parseFloat(getArg("--lng") || "11.0"),
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const parsed = parseArgs();
  if (!parsed) {
    process.exit(1);
  }

  const { config, lat, lng } = parsed;

  const resolvedCoverage = getCoverageIdForCoordinate(config.coverageId, lng);

  console.log("Configuration:");
  console.log(`  Base URL: ${config.baseUrl}`);
  console.log(`  Coverage ID: ${config.coverageId}${config.coverageId !== resolvedCoverage ? ` -> ${resolvedCoverage}` : ""}`);
  console.log(`  Zoom: ${config.zoom}`);
  console.log(`  Interpolate: ${config.interpolate}`);
  console.log(`  WCS Version: ${config.wcsVersion}`);
  console.log(`  Format: ${config.wcsFormat}`);
  console.log(`  CRS: ${config.wcsCrs}`);
  console.log(`  Axis Order: ${config.axisOrder}`);
  console.log(`  Tile Size: ${config.tileSize}`);
  console.log(`  Nodata Value: ${config.nodataValue}`);

  const batch = createWCSBatch(lat, lng, config);
  await fetchAndAnalyzeWCSTile(batch, config);
}

main().catch(console.error);
