import nock from "nock";
import { RunFeature } from "openskidata-format";
import { Config, getPostgresTestConfig } from "./Config";
import { PostGISDataStore } from "./io/PostGISDataStore";
import prepare from "./PrepareGeoJSON";
import * as TestHelpers from "./TestHelpers";

jest.setTimeout(60 * 1000);

// Configure nock to work with fetch/undici
nock.disableNetConnect();

// Create unique database name for each test to ensure isolation
let testConfig: Config;

function mockElevationServer(code: number) {
  nock("http://elevation.example.com")
    .post("/")
    .times(10) // Allow multiple requests but not persistent across tests
    .reply(code, (_, requestBody) => {
      if (code === 200) {
        const coordinates = requestBody as number[][];
        return coordinates.map((_, index) => index);
      } else {
        return "";
      }
    });
}

beforeEach(() => {
  // Create unique config for each test with isolated database
  testConfig = {
    elevationServer: {
      url: "http://elevation.example.com",
      type: "racemap",
      interpolate: true,
    },
    bbox: null,
    geocodingServer: null,
    workingDir: TestHelpers.getTempWorkingDir(),
    outputDir: TestHelpers.getTempWorkingDir(),
    snowCover: null,
    tiles: null,
    tiles3D: null,
    postgresCache: getPostgresTestConfig(),
    output: { toFiles: true, toPostgis: false },
    conflateElevation: true,
    exportOnly: false,
    localOSMDatabase: null,
  };
});

afterEach(() => {
  nock.cleanAll();
});

it("adds elevations to lift geometry", async () => {
  const paths = TestHelpers.getFilePaths();
  const dataStore = new PostGISDataStore(testConfig.postgresCache);
  try {
    mockElevationServer(200);
    await TestHelpers.mockInputFiles(
      {
        skiMapSkiAreas: [],
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
        runs: [],
      },
      dataStore,
    );

    await prepare(paths, testConfig);

    expect(TestHelpers.fileContents(paths.output.lifts)).toMatchInlineSnapshot(`
{
  "features": [
    {
      "geometry": {
        "coordinates": [
          [
            11.1223444,
            47.5572422,
            0,
          ],
          [
            11.1164297,
            47.55815630000001,
            1,
          ],
        ],
        "type": "LineString",
      },
      "properties": {
        "bubble": null,
        "capacity": null,
        "description": null,
        "detachable": null,
        "duration": null,
        "heating": null,
        "id": "e8e4058e82dd25aa12b4673471dd754a8b319f5c",
        "liftType": "t-bar",
        "name": "Skilift Oberau",
        "occupancy": null,
        "oneway": null,
        "places": [],
        "ref": null,
        "refFRCAIRN": null,
        "skiAreas": [],
        "sources": [
          {
            "id": "way/227407273",
            "type": "openstreetmap",
          },
        ],
        "status": "operating",
        "type": "lift",
        "websites": [],
        "wikidataID": null,
      },
      "type": "Feature",
    },
  ],
  "type": "FeatureCollection",
}
`);
  } finally {
    await dataStore.close();
  }
});

it("adds elevations to run geometry & elevation profile", async () => {
  const paths = TestHelpers.getFilePaths();
  const dataStore = new PostGISDataStore(testConfig.postgresCache);
  try {
    mockElevationServer(200);

    await TestHelpers.mockInputFiles(
      {
        skiMapSkiAreas: [],
        openStreetMapSkiAreas: [],
        openStreetMapSkiAreaSites: [],
        lifts: [],
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
              type: "LineString",
              coordinates: [
                [11.1164229, 47.558125],
                [11.1163655, 47.5579742],
                [11.1171866, 47.5556413],
              ],
            },
          },
        ],
      },
      dataStore,
    );

    await prepare(paths, testConfig);

    const feature: RunFeature = TestHelpers.fileContents(paths.output.runs)
      .features[0];

    expect(feature.properties.elevationProfile).toMatchInlineSnapshot(`
{
  "heights": [
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
  ],
  "resolution": 25,
}
`);
    expect(feature.geometry).toMatchInlineSnapshot(`
{
  "coordinates": [
    [
      11.1164229,
      47.558125000000004,
      0,
    ],
    [
      11.116365499999999,
      47.5579742,
      1,
    ],
    [
      11.1171866,
      47.5556413,
      2,
    ],
  ],
  "type": "LineString",
}
`);
  } finally {
    await dataStore.close();
  }
});

it("completes without adding elevations when elevation server fails", async () => {
  const paths = TestHelpers.getFilePaths();
  const dataStore = new PostGISDataStore(testConfig.postgresCache);
  try {
    mockElevationServer(500);
    await TestHelpers.mockInputFiles(
      {
        skiMapSkiAreas: [],
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
        runs: [],
      },
      dataStore,
    );

    await prepare(paths, testConfig);

    expect(TestHelpers.fileContents(paths.output.lifts)).toMatchInlineSnapshot(`
{
  "features": [
    {
      "geometry": {
        "coordinates": [
          [
            11.1223444,
            47.5572422,
          ],
          [
            11.1164297,
            47.55815630000001,
          ],
        ],
        "type": "LineString",
      },
      "properties": {
        "bubble": null,
        "capacity": null,
        "description": null,
        "detachable": null,
        "duration": null,
        "heating": null,
        "id": "e8e4058e82dd25aa12b4673471dd754a8b319f5c",
        "liftType": "t-bar",
        "name": "Skilift Oberau",
        "occupancy": null,
        "oneway": null,
        "places": [],
        "ref": null,
        "refFRCAIRN": null,
        "skiAreas": [],
        "sources": [
          {
            "id": "way/227407273",
            "type": "openstreetmap",
          },
        ],
        "status": "operating",
        "type": "lift",
        "websites": [],
        "wikidataID": null,
      },
      "type": "Feature",
    },
  ],
  "type": "FeatureCollection",
}
`);
  } finally {
    await dataStore.close();
  }
});

it("adds elevations to run polygons", async () => {
  const paths = TestHelpers.getFilePaths();
  const dataStore = new PostGISDataStore(testConfig.postgresCache);
  try {
    mockElevationServer(200);

    await TestHelpers.mockInputFiles(
      {
        skiMapSkiAreas: [],
        openStreetMapSkiAreas: [],
        openStreetMapSkiAreaSites: [],
        lifts: [],
        runs: [
          {
            type: "Feature",
            id: "way/227407273",
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
                  [6.544500899999999, 45.3230511],
                  [6.543409400000001, 45.323173700000005],
                  [6.5502579, 45.3224134],
                  [6.550612, 45.3222571],
                  [6.544500899999999, 45.3230511],
                ],
              ],
            },
          },
        ],
      },
      dataStore,
    );

    await prepare(paths, testConfig);

    expect(TestHelpers.fileContents(paths.output.runs).features[0].geometry)
      .toMatchInlineSnapshot(`
{
  "coordinates": [
    [
      [
        6.544500899999999,
        45.3230511,
        0,
      ],
      [
        6.543409400000001,
        45.323173700000005,
        1,
      ],
      [
        6.5502579,
        45.3224134,
        2,
      ],
      [
        6.550612,
        45.3222571,
        3,
      ],
      [
        6.544500899999999,
        45.3230511,
        4,
      ],
    ],
  ],
  "type": "Polygon",
}
`);
  } finally {
    await dataStore.close();
  }
});
