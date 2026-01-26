import * as fs from "fs";
import * as path from "path";
import { LocalDEMIndex } from "./LocalDEMIndex";
import {
  clearLocalDEMCache,
  fetchElevationsFromLocalDEM,
} from "./LocalDEMTerrainTiles";
import { ElevationServerConfig } from "../Config";

// Mock the geotiff module
jest.mock("geotiff", () => ({
  fromFile: jest.fn(),
}));

// Mock fs module
jest.mock("fs", () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
}));

describe("LocalDEMIndex", () => {
  const mockFromFile = jest.requireMock("geotiff").fromFile;
  const mockExistsSync = fs.existsSync as jest.Mock;
  const mockReaddirSync = fs.readdirSync as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    clearLocalDEMCache();
  });

  describe("initialize", () => {
    it("throws error if directory does not exist", async () => {
      mockExistsSync.mockReturnValue(false);

      const index = new LocalDEMIndex("/nonexistent/path");
      await expect(index.initialize()).rejects.toThrow(
        "Local DEM directory does not exist",
      );
    });

    it("initializes with empty directory", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([]);

      const index = new LocalDEMIndex("/data/dem");
      await index.initialize();

      expect(index.getFileCount()).toBe(0);
      expect(index.isInitialized()).toBe(true);
    });

    it("scans directory for .tif and .tiff files", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        "dem1.tif",
        "dem2.TIFF",
        "readme.txt",
        "other.png",
      ]);

      const mockImage = {
        getBoundingBox: jest.fn().mockReturnValue([6.0, 45.0, 7.0, 46.0]),
      };
      const mockTiff = {
        getImage: jest.fn().mockResolvedValue(mockImage),
      };
      mockFromFile.mockResolvedValue(mockTiff);

      const index = new LocalDEMIndex("/data/dem");
      await index.initialize();

      // Should only process .tif and .tiff files
      expect(mockFromFile).toHaveBeenCalledTimes(2);
      expect(mockFromFile).toHaveBeenCalledWith(
        path.join("/data/dem", "dem1.tif"),
      );
      expect(mockFromFile).toHaveBeenCalledWith(
        path.join("/data/dem", "dem2.TIFF"),
      );
    });

    it("skips files with invalid bounding boxes", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["valid.tif", "invalid.tif"]);

      const validImage = {
        getBoundingBox: jest.fn().mockReturnValue([6.0, 45.0, 7.0, 46.0]),
      };
      const invalidImage = {
        getBoundingBox: jest.fn().mockReturnValue([1000, 2000, 3000, 4000]), // Invalid WGS84
      };

      mockFromFile
        .mockResolvedValueOnce({ getImage: () => Promise.resolve(validImage) })
        .mockResolvedValueOnce({
          getImage: () => Promise.resolve(invalidImage),
        });

      const index = new LocalDEMIndex("/data/dem");
      await index.initialize();

      // Only valid file should be indexed
      expect(index.getFileCount()).toBe(1);
    });
  });

  describe("findFileForCoordinate", () => {
    it("throws error if not initialized", () => {
      const index = new LocalDEMIndex("/data/dem");
      expect(() => index.findFileForCoordinate(6.5, 45.5)).toThrow(
        "LocalDEMIndex not initialized",
      );
    });

    it("finds file containing coordinate", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["france.tif"]);

      const mockImage = {
        getBoundingBox: jest.fn().mockReturnValue([6.0, 45.0, 7.0, 46.0]),
      };
      mockFromFile.mockResolvedValue({
        getImage: () => Promise.resolve(mockImage),
      });

      const index = new LocalDEMIndex("/data/dem");
      await index.initialize();

      const result = index.findFileForCoordinate(6.5, 45.5);
      expect(result).toBe(path.join("/data/dem", "france.tif"));
    });

    it("returns null for coordinate outside coverage", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["france.tif"]);

      const mockImage = {
        getBoundingBox: jest.fn().mockReturnValue([6.0, 45.0, 7.0, 46.0]),
      };
      mockFromFile.mockResolvedValue({
        getImage: () => Promise.resolve(mockImage),
      });

      const index = new LocalDEMIndex("/data/dem");
      await index.initialize();

      const result = index.findFileForCoordinate(10.0, 50.0);
      expect(result).toBeNull();
    });

    it("handles multiple files and finds correct one", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["savoie.tif", "isere.tif"]);

      const savoieImage = {
        getBoundingBox: jest.fn().mockReturnValue([6.0, 45.0, 7.0, 46.0]),
      };
      const isereImage = {
        getBoundingBox: jest.fn().mockReturnValue([5.0, 45.0, 6.0, 46.0]),
      };

      mockFromFile
        .mockResolvedValueOnce({ getImage: () => Promise.resolve(savoieImage) })
        .mockResolvedValueOnce({ getImage: () => Promise.resolve(isereImage) });

      const index = new LocalDEMIndex("/data/dem");
      await index.initialize();

      // Point in Savoie
      const savoieResult = index.findFileForCoordinate(6.5, 45.5);
      expect(savoieResult).toBe(path.join("/data/dem", "savoie.tif"));

      // Point in Isere
      const isereResult = index.findFileForCoordinate(5.5, 45.5);
      expect(isereResult).toBe(path.join("/data/dem", "isere.tif"));
    });
  });
});

describe("fetchElevationsFromLocalDEM", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearLocalDEMCache();
  });

  it("returns error if directory not configured", async () => {
    const config: ElevationServerConfig = {
      url: "",
      type: "local-dem",
      interpolate: true,
      localDemDirectory: undefined,
    };

    const results = await fetchElevationsFromLocalDEM([[45.5, 6.5]], config);

    expect(results[0].ok).toBe(false);
    if (!results[0].ok) {
      expect(results[0].error).toContain("LOCAL_DEM_DIRECTORY not configured");
    }
  });
});

describe("coordinate conversion", () => {
  // Test the internal coordinate to pixel conversion logic
  it("correctly calculates pixel position for coordinate in bounding box", () => {
    // This tests the coordToPixel logic conceptually
    // bbox: [minLng, minLat, maxLng, maxLat] = [6.0, 45.0, 7.0, 46.0]
    // width = 1000, height = 1000

    const bbox = [6.0, 45.0, 7.0, 46.0];
    const width = 1000;
    const height = 1000;

    // Point at center of bbox (6.5, 45.5)
    const lng = 6.5;
    const lat = 45.5;

    const pixelX = ((lng - bbox[0]) / (bbox[2] - bbox[0])) * width;
    const pixelY = ((bbox[3] - lat) / (bbox[3] - bbox[1])) * height;

    expect(pixelX).toBe(500); // Center X
    expect(pixelY).toBe(500); // Center Y

    // Point at top-left corner (6.0, 46.0)
    const lng2 = 6.0;
    const lat2 = 46.0;

    const pixelX2 = ((lng2 - bbox[0]) / (bbox[2] - bbox[0])) * width;
    const pixelY2 = ((bbox[3] - lat2) / (bbox[3] - bbox[1])) * height;

    expect(pixelX2).toBe(0);
    expect(pixelY2).toBe(0);

    // Point at bottom-right corner (7.0, 45.0)
    const lng3 = 7.0;
    const lat3 = 45.0;

    const pixelX3 = ((lng3 - bbox[0]) / (bbox[2] - bbox[0])) * width;
    const pixelY3 = ((bbox[3] - lat3) / (bbox[3] - bbox[1])) * height;

    expect(pixelX3).toBe(1000);
    expect(pixelY3).toBe(1000);
  });
});

describe("bilinear interpolation", () => {
  // Test bilinear interpolation logic conceptually
  it("returns weighted average of surrounding pixels", () => {
    // Simplified test of bilinear interpolation formula
    // For a 2x2 grid with values: e00=100, e10=200, e01=150, e11=250
    // at position (0.5, 0.5), the result should be the average: 175

    const e00 = 100;
    const e10 = 200;
    const e01 = 150;
    const e11 = 250;
    const xFrac = 0.5;
    const yFrac = 0.5;

    const result =
      e00 * (1 - xFrac) * (1 - yFrac) +
      e10 * xFrac * (1 - yFrac) +
      e01 * (1 - xFrac) * yFrac +
      e11 * xFrac * yFrac;

    expect(result).toBe(175);
  });

  it("returns corner value when at exact corner", () => {
    const e00 = 100;
    const e10 = 200;
    const e01 = 150;
    const e11 = 250;

    // At (0, 0) should return e00
    const xFrac = 0;
    const yFrac = 0;
    const result =
      e00 * (1 - xFrac) * (1 - yFrac) +
      e10 * xFrac * (1 - yFrac) +
      e01 * (1 - xFrac) * yFrac +
      e11 * xFrac * yFrac;

    expect(result).toBe(100);
  });

  it("interpolates linearly along edges", () => {
    const e00 = 100;
    const e10 = 200;
    const e01 = 150;
    const e11 = 250;

    // At (0.5, 0) should be average of e00 and e10 = 150
    const result =
      e00 * (1 - 0.5) * (1 - 0) +
      e10 * 0.5 * (1 - 0) +
      e01 * (1 - 0.5) * 0 +
      e11 * 0.5 * 0;

    expect(result).toBe(150);
  });
});
