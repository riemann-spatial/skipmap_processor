import { SkiAreaActivity } from "openskidata-format";
import { Config, getPostgresTestConfig } from "./Config";
import { PostGISDataStore } from "./io/PostGISDataStore";
import prepare from "./PrepareSkiData";
import * as TestHelpers from "./TestHelpers";
import {
  simplifiedLiftFeature,
  simplifiedRunFeature,
  simplifiedSkiAreaFeature,
} from "./TestHelpers";

function createTestConfig(): Config {
  return {
    elevationServer: null,
    bbox: null,
    geocodingServer: null,
    workingDir: TestHelpers.getTempWorkingDir(),
    outputDir: TestHelpers.getTempWorkingDir(),
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
}

it("produces empty output for empty input", async () => {
  const paths = TestHelpers.getOutputPaths();
  const config = createTestConfig();
  const dataStore = new PostGISDataStore(config.postgresCache);
  try {
    await TestHelpers.mockInputFiles(
      {
        skiMapSkiAreas: [],
        openStreetMapSkiAreas: [],
        openStreetMapSkiAreaSites: [],
        lifts: [],
        runs: [],
      },
      dataStore,
    );

    await prepare(paths, config);

    const skiAreas = await TestHelpers.outputContents(dataStore, "ski_areas");
    const runs = await TestHelpers.outputContents(dataStore, "runs");
    const lifts = await TestHelpers.outputContents(dataStore, "lifts");

    expect(skiAreas.features).toEqual([]);
    expect(runs.features).toEqual([]);
    expect(lifts.features).toEqual([]);
  } finally {
    await dataStore.close();
  }
});

it("produces output for simple input", async () => {
  const paths = TestHelpers.getOutputPaths();
  const config = createTestConfig();
  const dataStore = new PostGISDataStore(config.postgresCache);
  try {
    await TestHelpers.mockInputFiles(
      {
        skiMapSkiAreas: [
          {
            type: "Feature",
            properties: {
              id: "13666",
              name: "Rabenkopflift Oberau",
              status: null,
              activities: [SkiAreaActivity.Downhill],
              scalerank: 1,
              official_website: null,
            },
            geometry: {
              type: "Point",
              coordinates: [11.122066084534, 47.557111836837],
            },
          },
        ],
        openStreetMapSkiAreas: [],
        openStreetMapSkiAreaSites: [],
        lifts: [
          {
            type: "Feature",
            id: "way/227407273",
            properties: {
              type: "way",
              id: 227407273,
              tags: {
                aerialway: "t-bar",
                name: "Skilift Oberau",
              },
            },
            geometry: {
              type: "LineString",
              coordinates: [
                [11.1223444, 47.5572422],
                [11.1164297, 47.5581563],
              ],
            },
          },
        ],
        runs: [
          {
            type: "Feature",
            id: "way/227407268",
            properties: {
              type: "way",
              id: 227407268,
              tags: {
                name: "Oberauer Skiabfahrt",
                "piste:difficulty": "easy",
                "piste:type": "downhill",
                sport: "skiing",
              },
            },
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
          },
        ],
      },
      dataStore,
    );

    await prepare(paths, config);

    const lifts = await TestHelpers.outputContents(dataStore, "lifts");
    const runs = await TestHelpers.outputContents(dataStore, "runs");
    const skiAreas = await TestHelpers.outputContents(dataStore, "ski_areas");

    expect(lifts.features).toHaveLength(1);
    expect(lifts.features[0].properties.name).toBe("Skilift Oberau");
    expect(lifts.features[0].properties.liftType).toBe("t-bar");

    expect(runs.features).toHaveLength(1);
    expect(runs.features[0].properties.name).toBe("Oberauer Skiabfahrt");
    expect(runs.features[0].properties.difficulty).toBe("easy");

    expect(skiAreas.features).toHaveLength(1);
    expect(skiAreas.features[0].properties.name).toBe("Rabenkopflift Oberau");
  } finally {
    await dataStore.close();
  }
});

it("shortens ski area names for Mapbox GL output", async () => {
  const paths = TestHelpers.getOutputPaths();
  const config = createTestConfig();
  const dataStore = new PostGISDataStore(config.postgresCache);
  try {
    const longName =
      "Ski Welt (Wilder Kaiser – Gosau, Scheffau, Ellmau - Going, Söll, Brixen, Westendorf, Hopfgarten - Itter - Kelchsau)";
    await TestHelpers.mockInputFiles(
      {
        skiMapSkiAreas: [
          {
            type: "Feature",
            properties: {
              id: "13666",
              name: longName,
              status: null,
              activities: [SkiAreaActivity.Downhill],
              scalerank: 1,
              official_website: null,
            },
            geometry: {
              type: "Point",
              coordinates: [11.122066084534, 47.557111836837],
            },
          },
        ],
        openStreetMapSkiAreas: [],
        openStreetMapSkiAreaSites: [],
        lifts: [],
        runs: [],
      },
      dataStore,
    );

    await prepare(paths, config);

    expect(
      (TestHelpers.fileContents(paths.mapboxGL.skiAreas) as { features: { properties: { name: string } }[] }).features[0]
        .properties.name,
    ).toBe("Ski Welt");

    const skiAreas = await TestHelpers.outputContents(dataStore, "ski_areas");
    expect(skiAreas.features[0].properties.name).toBe(longName);
  } finally {
    await dataStore.close();
  }
});

it("processes OpenStreetMap ski areas", async () => {
  const paths = TestHelpers.getOutputPaths();
  const config = createTestConfig();
  const dataStore = new PostGISDataStore(config.postgresCache);
  try {
    await TestHelpers.mockInputFiles(
      {
        skiMapSkiAreas: [],
        openStreetMapSkiAreas: [
          {
            type: "Feature",
            properties: {
              type: "way",
              id: 13666,
              tags: {
                landuse: "winter_sports",
              },
            },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [0, 1],
                  [1, 0],
                  [0, 0],
                ],
              ],
            },
          },
        ],
        openStreetMapSkiAreaSites: [],
        lifts: [],
        runs: [],
      },
      dataStore,
    );

    await prepare(paths, config);

    const skiAreas = await TestHelpers.outputContents(dataStore, "ski_areas");
    expect(skiAreas.features).toEqual([]);
  } finally {
    await dataStore.close();
  }
});

it("processes OpenStreetMap ski area sites", async () => {
  const paths = TestHelpers.getOutputPaths();
  const config = createTestConfig();
  const dataStore = new PostGISDataStore(config.postgresCache);
  try {
    await TestHelpers.mockInputFiles(
      {
        skiMapSkiAreas: [],
        openStreetMapSkiAreas: [],
        openStreetMapSkiAreaSites: [
          {
            id: 1,
            type: "relation",
            tags: {
              name: "Wendelstein",
            },
            members: [
              { type: "way", ref: 1, role: "" },
              { type: "way", ref: 2, role: "" },
            ],
          },
        ],
        lifts: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
            properties: {
              id: 1,
              type: "way",
              tags: { name: "Wendelsteinbahn", aerialway: "cable_car" },
            },
          },
        ],
        runs: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [1, 1],
                [0, 0],
              ],
            },
            properties: {
              id: 2,
              type: "way",
              tags: { name: "Westabfahrt", "piste:type": "downhill" },
            },
          },
        ],
      },
      dataStore,
    );

    await prepare(paths, config);

    const skiAreas = await TestHelpers.outputContents(dataStore, "ski_areas");
    expect(
  skiAreas.features.map(simplifiedSkiAreaFeature)
).toMatchInlineSnapshot(`
[
  {
    "activities": [
      "downhill",
    ],
    "id": "32e4db98597c43cebfe18b263bcf7b3740501b47",
    "name": "Wendelstein",
  },
]
`);

    const lifts = await TestHelpers.outputContents(dataStore, "lifts");
    expect(
  lifts.features.map(simplifiedLiftFeature)
).toMatchInlineSnapshot(`
[
  {
    "id": "fa8b7321d15e0f111786a467e69c7b8e1d4f9431",
    "name": "Wendelsteinbahn",
    "skiAreas": [
      "32e4db98597c43cebfe18b263bcf7b3740501b47",
    ],
  },
]
`);

    const runs = await TestHelpers.outputContents(dataStore, "runs");
    expect(
  runs.features.map(simplifiedRunFeature)
).toMatchInlineSnapshot(`
[
  {
    "id": "ab2c973773eabc9757213f2e917575286f7e6c7e",
    "name": "Westabfahrt",
    "skiAreas": [
      "32e4db98597c43cebfe18b263bcf7b3740501b47",
    ],
  },
]
`);
  } finally {
    await dataStore.close();
  }
});
