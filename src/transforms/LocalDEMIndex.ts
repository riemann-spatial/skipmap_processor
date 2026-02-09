import * as fs from "fs";
import { fromFile, GeoTIFFImage } from "geotiff";
import * as path from "path";
import { Logger } from "../utils/Logger";

interface DEMFileBounds {
  filePath: string;
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/**
 * Spatial index for local DEM GeoTIFF files.
 * Scans a directory for .tif files and extracts their bounding boxes.
 */
export class LocalDEMIndex {
  private files: DEMFileBounds[] = [];
  private initialized = false;

  constructor(private readonly directory: string) {}

  /**
   * Initialize the index by scanning the directory for GeoTIFF files.
   * Must be called before using findFileForCoordinate.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!fs.existsSync(this.directory)) {
      throw new Error(`Local DEM directory does not exist: ${this.directory}`);
    }

    const entries = fs.readdirSync(this.directory);
    const tifFiles = entries.filter(
      (entry) =>
        entry.toLowerCase().endsWith(".tif") ||
        entry.toLowerCase().endsWith(".tiff"),
    );

    if (tifFiles.length === 0) {
      Logger.warn(`No GeoTIFF files found in ${this.directory}`);
    }

    for (const tifFile of tifFiles) {
      const filePath = path.join(this.directory, tifFile);
      try {
        const bounds = await this.extractBounds(filePath);
        if (bounds) {
          this.files.push(bounds);
        }
      } catch (error) {
        Logger.warn(`Failed to index DEM file ${tifFile}: ${error}`);
      }
    }

    Logger.log(
      `LocalDEMIndex initialized with ${this.files.length} file(s) from ${this.directory}`,
    );
    this.initialized = true;
  }

  /**
   * Extract bounding box from a GeoTIFF file.
   * Assumes the GeoTIFF is in WGS84 (EPSG:4326) projection.
   */
  private async extractBounds(filePath: string): Promise<DEMFileBounds | null> {
    const tiff = await fromFile(filePath);
    const image: GeoTIFFImage = await tiff.getImage();

    const bbox = image.getBoundingBox();
    if (!bbox || bbox.length < 4) {
      Logger.warn(`Could not extract bounding box from ${filePath}`);
      return null;
    }

    // GeoTIFF bbox is [minX, minY, maxX, maxY] = [minLng, minLat, maxLng, maxLat]
    const [minLng, minLat, maxLng, maxLat] = bbox;

    // Sanity check for WGS84 coordinates
    if (
      minLng < -180 ||
      maxLng > 180 ||
      minLat < -90 ||
      maxLat > 90 ||
      minLng > maxLng ||
      minLat > maxLat
    ) {
      Logger.warn(
        `GeoTIFF ${filePath} has invalid or non-WGS84 bounds: [${minLng}, ${minLat}, ${maxLng}, ${maxLat}]. ` +
          `Ensure the file is reprojected to EPSG:4326.`,
      );
      return null;
    }

    return { filePath, minLng, minLat, maxLng, maxLat };
  }

  /**
   * Find the DEM file that contains the given coordinate.
   * Returns null if no file covers the coordinate.
   */
  findFileForCoordinate(lng: number, lat: number): string | null {
    if (!this.initialized) {
      throw new Error(
        "LocalDEMIndex not initialized. Call initialize() first.",
      );
    }

    for (const file of this.files) {
      if (
        lng >= file.minLng &&
        lng <= file.maxLng &&
        lat >= file.minLat &&
        lat <= file.maxLat
      ) {
        return file.filePath;
      }
    }

    return null;
  }

  /**
   * Get all indexed files.
   */
  getFiles(): DEMFileBounds[] {
    return [...this.files];
  }

  /**
   * Check if the index has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the number of indexed files.
   */
  getFileCount(): number {
    return this.files.length;
  }
}
