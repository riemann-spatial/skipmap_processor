import {
  LiftType,
  RunDifficulty,
  RunFeature,
  RunUse,
  SkiAreaActivity,
  SourceType,
  Status,
} from "openskidata-format";
import * as TestHelpers from "../TestHelpers";
import {
  simplifiedLiftFeature,
  simplifiedRunFeature,
  simplifiedSkiAreaFeature,
} from "../TestHelpers";
import clusterSkiAreas from "./ClusterSkiAreas";
import { Config, getPostgresTestConfig } from "../Config";
import { PostGISDataStore } from "../io/PostGISDataStore";

jest.setTimeout(60 * 1000);

let mockUuidCount = 0;
jest.mock("uuid", () => {
  return {
    v4: () => "mock-UUID-" + mockUuidCount++,
  };
});

let testConfig: Config;
let dataStore: PostGISDataStore;

beforeEach(() => {
  mockUuidCount = 0;
  testConfig = {
    workingDir: TestHelpers.getTempWorkingDir(),
    outputDir: TestHelpers.getTempWorkingDir(),
    bbox: null,
    elevationServer: null,
    geocodingServer: null,
    snowCover: null,
    tiles: null,
    tiles3D: null,
    postgresCache: getPostgresTestConfig(),
    output: { toFiles: true },
    conflateElevation: true,
    exportOnly: false,
    startAtAssociatingHighways: false,
    continueWithDEM: false,
    continueProcessingPeaks: false,
    localOSMDatabase: null,
  };
  dataStore = new PostGISDataStore(testConfig.postgresCache);
});

afterEach(async () => {
  await dataStore.close();
});

/**
 * Integration test that verifies the SQLite clustering correctly
 * associates lifts and runs with ski areas.
 *
 * This test creates a scenario with:
 * - A Skimap.org ski area (point geometry)
 * - A lift and run nearby that should be associated
 *
 * The expected behavior is that the lift and run should have
 * the ski area ID in their skiAreas property after clustering.
 *
 * This test was originally written to reproduce a bug where SQLite
 * clustering resulted in empty skiAreas arrays, but that has been fixed.
 */
it("correctly associates lifts and runs with ski areas", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "test-ski-area-1",
        name: "Test Ski Area",
        status: Status.Operating,
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.SKIMAP_ORG, id: "12345" }],
        geometry: {
          type: "Point",
          coordinates: [11.122066, 47.557111],
        },
      }),
    ],
    [
      TestHelpers.mockLiftFeature({
        id: "test-lift-1",
        name: "Test Lift",
        liftType: LiftType.TBar,
        status: Status.Operating,
        geometry: {
          type: "LineString",
          coordinates: [
            [11.1223444, 47.5572422],
            [11.1164297, 47.5581563],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockRunFeature({
        id: "test-run-1",
        name: "Test Run",
        uses: [RunUse.Downhill],
        difficulty: RunDifficulty.EASY,
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [11.1164229, 47.558125],
              [11.1163655, 47.5579742],
              [11.1171866, 47.5576413],
              [11.1164229, 47.558125],
            ],
          ],
        },
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  const lifts = (await TestHelpers.outputContents(dataStore, "lifts")).features.map(
    simplifiedLiftFeature,
  );

  const runs = (await TestHelpers.outputContents(dataStore, "runs")).features.map(
    simplifiedRunFeature,
  );

  const skiAreas = (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
    simplifiedSkiAreaFeature,
  );

  // Verify that ski area associations are correctly populated
  expect(lifts).toEqual([
    {
      id: "test-lift-1",
      name: "Test Lift",
      skiAreas: ["test-ski-area-1"],
    },
  ]);

  expect(runs).toEqual([
    {
      id: "test-run-1",
      name: "Test Run",
      skiAreas: ["test-ski-area-1"],
    },
  ]);

  expect(skiAreas).toEqual([
    {
      activities: ["downhill"],
      id: "test-ski-area-1",
      name: "Test Ski Area",
    },
  ]);
});

/**
 * Test that verifies ski area associations persist through the entire
 * clustering and augmentation pipeline.
 */
it("verifies ski area associations persist through clustering and augmentation", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "ski-area-simple",
        name: "Simple Ski Area",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.SKIMAP_ORG, id: "54321" }],
        geometry: {
          type: "Point",
          coordinates: [0, 0],
        },
      }),
    ],
    [
      TestHelpers.mockLiftFeature({
        id: "lift-simple",
        name: "Simple Lift",
        liftType: LiftType.ChairLift,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.001, 0.001],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockRunFeature({
        id: "run-simple",
        name: "Simple Run",
        uses: [RunUse.Downhill],
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.001, 0.001],
          ],
        },
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  const outputRuns = (await TestHelpers.outputContents(dataStore, "runs")).features;
  const outputLifts = (await TestHelpers.outputContents(dataStore, "lifts")).features;

  // Verify that ski area associations are correctly populated
  expect(outputRuns[0]?.properties?.skiAreas).not.toEqual([]);
  expect(outputLifts[0]?.properties?.skiAreas).not.toEqual([]);
});
