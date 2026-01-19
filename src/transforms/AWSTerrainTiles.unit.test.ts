import {
  latLngToTileXY,
  latLngToPixelInTile,
  getGeoTiffTileCoords,
  batchCoordinatesByTile,
} from "./AWSTerrainTiles";

describe("AWSTerrainTiles", () => {
  describe("latLngToTileXY", () => {
    it("converts known coordinates correctly at zoom 15", () => {
      // Innsbruck, Austria (47.2692, 11.4041)
      const result = latLngToTileXY(47.2692, 11.4041, 15);
      expect(result.tileX).toBe(17422);
      expect(result.tileY).toBe(11489);
    });

    it("converts coordinates at zoom 0 to single tile", () => {
      const result = latLngToTileXY(0, 0, 0);
      expect(result.tileX).toBe(0);
      expect(result.tileY).toBe(0);
    });

    it("handles negative longitude correctly", () => {
      // Denver, Colorado (-104.9903, 39.7392)
      const result = latLngToTileXY(39.7392, -104.9903, 15);
      expect(result.tileX).toBe(6827);
      expect(result.tileY).toBe(12436);
    });

    it("handles southern hemisphere correctly", () => {
      // Queenstown, New Zealand (-45.0312, 168.6626)
      const result = latLngToTileXY(-45.0312, 168.6626, 15);
      expect(result.tileX).toBe(31736);
      expect(result.tileY).toBe(20984);
    });

    it("clamps latitude near poles", () => {
      // Near North Pole - should clamp to valid range
      const result = latLngToTileXY(85, 0, 15);
      expect(result.tileX).toBeGreaterThanOrEqual(0);
      expect(result.tileY).toBeGreaterThanOrEqual(0);
      expect(result.tileX).toBeLessThan(Math.pow(2, 15));
      expect(result.tileY).toBeLessThan(Math.pow(2, 15));
    });

    it("handles dateline correctly", () => {
      // Near dateline (180 degrees)
      const result = latLngToTileXY(0, 179.9, 15);
      expect(result.tileX).toBe(32758);

      const resultWest = latLngToTileXY(0, -179.9, 15);
      expect(resultWest.tileX).toBe(9);
    });
  });

  describe("latLngToPixelInTile", () => {
    it("returns pixel coordinates within valid range 0-255", () => {
      const { tileX, tileY } = latLngToTileXY(47.2692, 11.4041, 15);
      const { pixelX, pixelY } = latLngToPixelInTile(
        47.2692,
        11.4041,
        15,
        tileX,
        tileY,
      );
      expect(pixelX).toBeGreaterThanOrEqual(0);
      expect(pixelX).toBeLessThanOrEqual(255);
      expect(pixelY).toBeGreaterThanOrEqual(0);
      expect(pixelY).toBeLessThanOrEqual(255);
    });

    it("returns consistent pixel position for same coordinate", () => {
      const lat = 47.5;
      const lng = 11.0;
      const { tileX, tileY } = latLngToTileXY(lat, lng, 15);
      const pixel1 = latLngToPixelInTile(lat, lng, 15, tileX, tileY);
      const pixel2 = latLngToPixelInTile(lat, lng, 15, tileX, tileY);
      expect(pixel1.pixelX).toBe(pixel2.pixelX);
      expect(pixel1.pixelY).toBe(pixel2.pixelY);
    });

    it("different coordinates in same tile have different pixels", () => {
      const { tileX, tileY } = latLngToTileXY(47.5, 11.0, 15);
      const pixel1 = latLngToPixelInTile(47.5, 11.0, 15, tileX, tileY);
      const pixel2 = latLngToPixelInTile(47.5001, 11.0001, 15, tileX, tileY);
      // Small coordinate change should result in different pixels
      expect(
        pixel1.pixelX !== pixel2.pixelX || pixel1.pixelY !== pixel2.pixelY,
      ).toBe(true);
    });
  });

  describe("getGeoTiffTileCoords", () => {
    it("calculates parent tile for even coordinates", () => {
      const result = getGeoTiffTileCoords(100, 200);
      expect(result.geoTiffX).toBe(50);
      expect(result.geoTiffY).toBe(100);
      expect(result.quadrantX).toBe(0);
      expect(result.quadrantY).toBe(0);
    });

    it("calculates parent tile for odd coordinates", () => {
      const result = getGeoTiffTileCoords(101, 201);
      expect(result.geoTiffX).toBe(50);
      expect(result.geoTiffY).toBe(100);
      expect(result.quadrantX).toBe(1);
      expect(result.quadrantY).toBe(1);
    });

    it("returns correct quadrant for all four quadrants", () => {
      // Top-left quadrant (0,0)
      expect(getGeoTiffTileCoords(0, 0)).toEqual({
        geoTiffX: 0,
        geoTiffY: 0,
        quadrantX: 0,
        quadrantY: 0,
      });

      // Top-right quadrant (1,0)
      expect(getGeoTiffTileCoords(1, 0)).toEqual({
        geoTiffX: 0,
        geoTiffY: 0,
        quadrantX: 1,
        quadrantY: 0,
      });

      // Bottom-left quadrant (0,1)
      expect(getGeoTiffTileCoords(0, 1)).toEqual({
        geoTiffX: 0,
        geoTiffY: 0,
        quadrantX: 0,
        quadrantY: 1,
      });

      // Bottom-right quadrant (1,1)
      expect(getGeoTiffTileCoords(1, 1)).toEqual({
        geoTiffX: 0,
        geoTiffY: 0,
        quadrantX: 1,
        quadrantY: 1,
      });
    });
  });

  describe("batchCoordinatesByTile", () => {
    const baseUrl = "https://s3.amazonaws.com/elevation-tiles-prod/geotiff";

    it("groups coordinates on same tile together", () => {
      // Two points very close together (same tile)
      const coordinates = [
        [47.5, 11.0],
        [47.5001, 11.0001],
      ];
      const batches = batchCoordinatesByTile(coordinates, baseUrl, 15, true);
      expect(batches.length).toBe(1);
      expect(batches[0].coordinates.length).toBe(2);
    });

    it("separates coordinates on different tiles", () => {
      // Two points far apart (different tiles)
      const coordinates = [
        [47.5, 11.0],
        [48.0, 12.0],
      ];
      const batches = batchCoordinatesByTile(coordinates, baseUrl, 15, true);
      expect(batches.length).toBe(2);
    });

    it("preserves original indices", () => {
      const coordinates = [
        [47.5, 11.0],
        [48.0, 12.0],
        [47.5001, 11.0001], // Same tile as first
      ];
      const batches = batchCoordinatesByTile(coordinates, baseUrl, 15, true);

      // Find all original indices across batches
      const allIndices = batches.flatMap((b) =>
        b.coordinates.map((c) => c.originalIndex),
      );
      expect(allIndices.sort()).toEqual([0, 1, 2]);
    });

    it("generates correct tile URLs with z-1 zoom level", () => {
      const coordinates = [[47.5, 11.0]];
      const batches = batchCoordinatesByTile(coordinates, baseUrl, 15, true);

      // URL should use zoom 14 (z-1)
      expect(batches[0].url).toContain("/14/");
      expect(batches[0].url).toMatch(/\/14\/\d+\/\d+\.tif$/);
    });

    it("calculates pixel coordinates within 0-511 range", () => {
      const coordinates = [
        [47.5, 11.0],
        [47.5001, 11.0001],
        [47.4999, 10.9999],
      ];
      const batches = batchCoordinatesByTile(coordinates, baseUrl, 15, true);

      for (const batch of batches) {
        for (const coord of batch.coordinates) {
          expect(coord.pixelX).toBeGreaterThanOrEqual(0);
          expect(coord.pixelX).toBeLessThanOrEqual(511);
          expect(coord.pixelY).toBeGreaterThanOrEqual(0);
          expect(coord.pixelY).toBeLessThanOrEqual(511);
        }
      }
    });

    it("handles empty coordinates array", () => {
      const batches = batchCoordinatesByTile([], baseUrl, 15, true);
      expect(batches).toEqual([]);
    });

    it("handles single coordinate", () => {
      const coordinates = [[47.5, 11.0]];
      const batches = batchCoordinatesByTile(coordinates, baseUrl, 15, true);
      expect(batches.length).toBe(1);
      expect(batches[0].coordinates.length).toBe(1);
      expect(batches[0].coordinates[0].originalIndex).toBe(0);
    });

    it("passes interpolate flag to batches", () => {
      const coordinates = [[47.5, 11.0]];
      const batchesWithInterpolation = batchCoordinatesByTile(
        coordinates,
        baseUrl,
        15,
        true,
      );
      expect(batchesWithInterpolation[0].interpolate).toBe(true);

      const batchesWithoutInterpolation = batchCoordinatesByTile(
        coordinates,
        baseUrl,
        15,
        false,
      );
      expect(batchesWithoutInterpolation[0].interpolate).toBe(false);
    });
  });
});
