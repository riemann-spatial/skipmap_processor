import {
  LiftType,
  RunDifficulty,
  RunFeature,
  RunGrooming,
  RunUse,
  SkiAreaActivity,
  SkiAreaFeature,
  SourceType,
  Status,
} from "openskidata-format";
import { Config, getPostgresTestConfig } from "../Config";
import { PostGISDataStore } from "../io/PostGISDataStore";
import * as TestHelpers from "../TestHelpers";
import {
  simplifiedLiftFeature,
  simplifiedRunFeature,
  simplifiedSkiAreaFeature,
  simplifiedSkiAreaFeatureWithSources,
  simplifiedSkiAreaFeatureWithStatistics,
} from "../TestHelpers";
import { toSkiAreaSummary } from "../transforms/toSkiAreaSummary";
import clusterSkiAreas from "./ClusterSkiAreas";

let mockUuidCount = 0;
jest.mock("uuid", () => {
  return { v4: () => "mock-UUID-" + mockUuidCount++ };
});

// Increase timeout to give time to set up PostgreSQL database
jest.setTimeout(60 * 1000);

let testConfig: Config;
let dataStore: PostGISDataStore;

beforeEach(async () => {
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

it("skips generating ski areas for runs with unsupported activity", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "3",
        name: "Sledding run",
        uses: [RunUse.Sled],
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

  expect(await TestHelpers.outputContents(dataStore, "ski_areas"))
    .toMatchInlineSnapshot(`
    {
      "features": [],
      "type": "FeatureCollection",
    }
  `);
});

it("generates ski areas for runs without them", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [
      TestHelpers.mockLiftFeature({
        id: "1",
        name: "Lift",
        liftType: LiftType.ChairLift,
        geometry: {
          type: "LineString",
          coordinates: [
            [11.1164229, 47.558125],
            [11.1163655, 47.5579742],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockRunFeature({
        id: "3",
        name: "Oberauer Skiabfahrt",
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
      TestHelpers.mockRunFeature({
        id: "4",
        name: "Another run nearby",
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

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "3",
        "name": "Oberauer Skiabfahrt",
        "skiAreas": [
          "mock-UUID-0",
        ],
      },
      {
        "id": "4",
        "name": "Another run nearby",
        "skiAreas": [
          "mock-UUID-0",
        ],
      },
    ]
  `);
  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
      simplifiedSkiAreaFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "activities": [
          "downhill",
        ],
        "id": "mock-UUID-0",
        "name": null,
      },
    ]
  `);
});

it("does not generate ski area for lone downhill run without lift", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "3",
        name: "Oberauer Skiabfahrt",
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
      TestHelpers.mockRunFeature({
        id: "4",
        name: "Another run nearby",
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

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "3",
        "name": "Oberauer Skiabfahrt",
        "skiAreas": [],
      },
      {
        "id": "4",
        "name": "Another run nearby",
        "skiAreas": [],
      },
    ]
  `);
  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
      simplifiedSkiAreaFeature,
    ),
  ).toMatchInlineSnapshot(`[]`);
});

it("generates ski areas by activity", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [
      TestHelpers.mockLiftFeature({
        id: "1",
        name: "Lift",
        liftType: LiftType.ChairLift,
        geometry: {
          type: "LineString",
          coordinates: [
            [11.1164229, 47.558125],
            [11.1163655, 47.5579742],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockRunFeature({
        id: "3",
        name: "Downhill Run",
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
      TestHelpers.mockRunFeature({
        id: "4",
        name: "Nordic run",
        uses: [RunUse.Nordic],
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

  const runs: RunFeature[] = (await TestHelpers.outputContents(dataStore, "runs")).features as RunFeature[];
  expect(
    runs.map((feature) => {
      return {
        ...simplifiedRunFeature(feature),
        // Inline only the ski area activities to avoid flaky test failures due to mismatched ski area IDs
        //  when one ski area is generated before the other.
        skiAreas: feature.properties.skiAreas.map(
          (skiArea) => skiArea.properties.activities,
        ),
      };
    }),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "3",
        "name": "Downhill Run",
        "skiAreas": [
          [
            "downhill",
          ],
        ],
      },
      {
        "id": "4",
        "name": "Nordic run",
        "skiAreas": [
          [
            "nordic",
          ],
        ],
      },
    ]
  `);
});

it("clusters ski areas", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        name: "Rabenkopflift Oberau",
        status: Status.Operating,
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.SKIMAP_ORG, id: "13666" }],
        geometry: {
          type: "Point",
          coordinates: [11.122066084534, 47.557111836837],
        },
      }),
    ],
    [
      TestHelpers.mockLiftFeature({
        id: "2",
        name: "Skilift Oberau",
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
        id: "3",
        name: "Oberauer Skiabfahrt",
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

  expect(
    (await TestHelpers.outputContents(dataStore, "lifts")).features.map(
      simplifiedLiftFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "2",
        "name": "Skilift Oberau",
        "skiAreas": [
          "1",
        ],
      },
    ]
  `);

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "3",
        "name": "Oberauer Skiabfahrt",
        "skiAreas": [
          "1",
        ],
      },
    ]
  `);

  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
      simplifiedSkiAreaFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "activities": [
          "downhill",
        ],
        "id": "1",
        "name": "Rabenkopflift Oberau",
      },
    ]
  `);
});

it("clusters ski area activities independently", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [SkiAreaActivity.Downhill, SkiAreaActivity.Nordic],
        geometry: { type: "Point", coordinates: [0, 0] },
      }),
    ],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        name: "Downhill run part of ski area",
        uses: [RunUse.Downhill],
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      }),
      TestHelpers.mockRunFeature({
        id: "3",
        name: "Nordic run part of ski area",
        uses: [RunUse.Nordic],
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [-1, -1],
          ],
        },
      }),
      TestHelpers.mockRunFeature({
        id: "4",
        name: "Nordic run not part of ski area",
        uses: [RunUse.Nordic],
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 1],
            [2, 2],
          ],
        },
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "2",
        "name": "Downhill run part of ski area",
        "skiAreas": [
          "1",
        ],
      },
      {
        "id": "3",
        "name": "Nordic run part of ski area",
        "skiAreas": [
          "1",
        ],
      },
      {
        "id": "4",
        "name": "Nordic run not part of ski area",
        "skiAreas": [
          "mock-UUID-0",
        ],
      },
    ]
  `);
});

it("generates a downhill ski area but does not include backcountry runs when clustering from a mixed use run", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [
      TestHelpers.mockLiftFeature({
        id: "1",
        name: "Lift",
        liftType: LiftType.ChairLift,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockRunFeature({
        id: "3",
        name: "Downhill Run & Backcountry Route",
        uses: [RunUse.Downhill, RunUse.Skitour],
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      }),
      TestHelpers.mockRunFeature({
        id: "4",
        name: "Backcountry Route",
        uses: [RunUse.Skitour],
        difficulty: RunDifficulty.EASY,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0, 1],
          ],
        },
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "3",
        "name": "Downhill Run & Backcountry Route",
        "skiAreas": [
          "mock-UUID-0",
        ],
      },
      {
        "id": "4",
        "name": "Backcountry Route",
        "skiAreas": [],
      },
    ]
  `);
});

it("generates elevation statistics for run & lift based on lift served skiable vertical", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [
      TestHelpers.mockLiftFeature({
        id: "2",
        name: "Skilift Oberau",
        liftType: LiftType.TBar,
        status: Status.Operating,
        geometry: {
          type: "LineString",
          coordinates: [
            [11.1223444, 47.5572422, 100],
            [11.1164297, 47.5581563, 200],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockRunFeature({
        id: "3",
        name: "Downhill Run",
        uses: [RunUse.Downhill],
        geometry: {
          type: "LineString",
          coordinates: [
            [11.1220444, 47.5572422, 150],
            [11.1160297, 47.5581563, 250],
          ],
        },
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
  (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
    simplifiedSkiAreaFeatureWithStatistics
  )
).toMatchInlineSnapshot(`
[
  {
    "activities": [
      "downhill",
    ],
    "id": "mock-UUID-0",
    "name": null,
    "statistics": {
      "lifts": {
        "byType": {
          "t-bar": {
            "combinedElevationChange": 100,
            "count": 1,
            "lengthInKm": 0.4553273553617682,
            "maxElevation": 200,
            "minElevation": 100,
          },
        },
        "maxElevation": 200,
        "minElevation": 100,
      },
      "maxElevation": 200,
      "minElevation": 150,
      "runs": {
        "byActivity": {
          "downhill": {
            "byDifficulty": {
              "other": {
                "combinedElevationChange": 100,
                "count": 1,
                "lengthInKm": 0.46264499967407724,
                "maxElevation": 250,
                "minElevation": 150,
              },
            },
          },
        },
        "maxElevation": 250,
        "minElevation": 150,
      },
    },
  },
]
`);
});

it("generates statistics for run with backcountry grooming with site membership", async () => {

  const skiAreaSite = TestHelpers.mockSkiAreaSiteFeature({
    id: "1",
    osmID: 1,
    activities: [],
    sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
  });
  await TestHelpers.mockProcessingFeatures(
    [skiAreaSite],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "3",
        name: "Downhill Run",
        uses: [RunUse.Downhill],
        grooming: RunGrooming.Backcountry,
        skiAreas: [skiAreaSite],
        geometry: {
          type: "LineString",
          coordinates: [
            [11.1220444, 47.5572422, 150],
            [11.1160297, 47.5581563, 250],
          ],
        },
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
  (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
    simplifiedSkiAreaFeatureWithStatistics
  )
).toMatchInlineSnapshot(`
[
  {
    "activities": [
      "downhill",
    ],
    "id": "1",
    "name": "Name",
    "statistics": {
      "lifts": {
        "byType": {},
      },
      "maxElevation": 250,
      "minElevation": 150,
      "runs": {
        "byActivity": {
          "downhill": {
            "byDifficulty": {
              "other": {
                "combinedElevationChange": 100,
                "count": 1,
                "lengthInKm": 0.46264499967407724,
                "maxElevation": 250,
                "minElevation": 150,
              },
            },
          },
        },
        "maxElevation": 250,
        "minElevation": 150,
      },
    },
  },
]
`);
});

it("allows point & multilinestring lifts to be processed", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [
      TestHelpers.mockLiftFeature({
        id: "2",
        name: "Skilift Oberau",
        liftType: LiftType.TBar,
        status: Status.Operating,
        geometry: {
          type: "MultiLineString",
          coordinates: [
            [
              [25.430488, 36.420539900000016, 238.44396972656193],
              [25.4273675, 36.4188913, 18.190246582031193],
            ],
            [
              [25.427413799999993, 36.4188392, 15.1902456283569],
              [25.430537199999993, 36.4204801, 237.44396972656193],
            ],
          ],
        },
      }),
      TestHelpers.mockLiftFeature({
        id: "3",
        name: "Gondola",
        liftType: LiftType.Gondola,
        geometry: {
          type: "LineString",
          coordinates: [
            [12.2447153, 47.5270405, 719.0122680664059],
            [12.2547153, 47.5370405, 819.0122680664059],
          ],
        },
      }),
    ],
    [],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "lifts")).features.map(
      simplifiedLiftFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "2",
        "name": "Skilift Oberau",
        "skiAreas": [],
      },
      {
        "id": "3",
        "name": "Gondola",
        "skiAreas": [],
      },
    ]
  `);
});

it("does not generate ski area for lone snow park", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "1",
        name: "Terrain Park",
        uses: [RunUse.SnowPark],
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

  expect(await TestHelpers.outputContents(dataStore, "ski_areas"))
    .toMatchInlineSnapshot(`
    {
      "features": [],
      "type": "FeatureCollection",
    }
  `);
});

it("generates ski area which includes the snow park", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [
      TestHelpers.mockLiftFeature({
        id: "3",
        name: "Lift",
        liftType: LiftType.ChairLift,
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
        id: "1",
        name: "Run",
        uses: [RunUse.Downhill],
        difficulty: RunDifficulty.EASY,
        geometry: {
          type: "LineString",
          coordinates: [
            [11.1223444, 47.5572422],
            [11.1164297, 47.5581563],
          ],
        },
      }),
      TestHelpers.mockRunFeature({
        id: "2",
        name: "Terrain Park",
        uses: [RunUse.SnowPark],
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

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "1",
        "name": "Run",
        "skiAreas": [
          "mock-UUID-0",
        ],
      },
      {
        "id": "2",
        "name": "Terrain Park",
        "skiAreas": [
          "mock-UUID-0",
        ],
      },
    ]
  `);
});

it("generates ski area which includes the patrolled ungroomed run", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [
      TestHelpers.mockLiftFeature({
        id: "2",
        liftType: LiftType.ChairLift,
        name: "Chairlift",
        geometry: {
          type: "LineString",
          coordinates: [
            [11.1164229, 47.558125],
            [11.1163655, 47.5579742],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockRunFeature({
        id: "1",
        name: "Run",
        uses: [RunUse.Downhill],
        patrolled: true,
        grooming: RunGrooming.Backcountry,
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

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "1",
        "name": "Run",
        "skiAreas": [
          "mock-UUID-0",
        ],
      },
    ]
  `);
});

it("does not generate ski area for ungroomed run", async () => {
  await TestHelpers.mockProcessingFeatures(
    [],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "1",
        name: "Run",
        uses: [RunUse.Downhill],
        grooming: RunGrooming.Backcountry,
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

  expect(await TestHelpers.outputContents(dataStore, "ski_areas"))
    .toMatchInlineSnapshot(`
    {
      "features": [],
      "type": "FeatureCollection",
    }
  `);
});

it("associates lifts and runs with polygon openstreetmap ski area", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        name: "Rabenkopflift Oberau",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "13666" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [11, 47],
              [12, 47],
              [12, 48],
              [11, 48],
              [11, 47],
            ],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockLiftFeature({
        id: "2",
        name: "Skilift Oberau",
        liftType: LiftType.TBar,
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
        id: "3",
        name: "Oberauer Skiabfahrt",
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

  expect(
    (await TestHelpers.outputContents(dataStore, "lifts")).features.map(
      simplifiedLiftFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "2",
        "name": "Skilift Oberau",
        "skiAreas": [
          "1",
        ],
      },
    ]
  `);

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "3",
        "name": "Oberauer Skiabfahrt",
        "skiAreas": [
          "1",
        ],
      },
    ]
  `);
});

it("associates lifts and runs adjacent to polygon openstreetmap ski area when no other polygon contains them", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        name: "Ski Area",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "13666" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0.0001],
              [0.0001, 0.0001],
              [0.0001, 0.0002],
              [0, 0.0002],
              [0, 0.0001],
            ],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockLiftFeature({
        id: "2",
        name: "Lift",
        liftType: LiftType.TBar,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockRunFeature({
        id: "3",
        name: "Run",
        uses: [RunUse.Downhill],
        difficulty: RunDifficulty.EASY,
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
          ],
        },
      }),
      TestHelpers.mockRunFeature({
        id: "4",
        name: "Run",
        uses: [RunUse.Downhill],
        difficulty: RunDifficulty.EASY,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0.0001],
            [0.0001, 0.0002],
          ],
        },
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "lifts")).features.map(
      simplifiedLiftFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "2",
        "name": "Lift",
        "skiAreas": [
          "1",
        ],
      },
    ]
  `);

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "3",
        "name": "Run",
        "skiAreas": [
          "1",
        ],
      },
      {
        "id": "4",
        "name": "Run",
        "skiAreas": [
          "1",
        ],
      },
    ]
  `);
});

it("associates lifts correctly to adjacent ski areas based on their polygons", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      }),
      TestHelpers.mockSkiAreaFeature({
        id: "2",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "2" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [-1, 0],
              [-1, -1],
              [0, -1],
              [0, 0],
            ],
          ],
        },
      }),
    ],
    [
      TestHelpers.mockLiftFeature({
        id: "3",
        name: "Ski Area 1: Lift",
        liftType: LiftType.TBar,
        geometry: {
          type: "LineString",
          coordinates: [
            [0.0001, 0.0001],
            [1, 0.0001],
          ],
        },
      }),
      TestHelpers.mockLiftFeature({
        id: "4",
        name: "Ski Area 2: Lift",
        liftType: LiftType.TBar,
        geometry: {
          type: "LineString",
          coordinates: [
            [-0.0001, -0.0001],
            [-1, -0.0001],
          ],
        },
      }),
    ],
    [],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "lifts")).features.map(
      simplifiedLiftFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "3",
        "name": "Ski Area 1: Lift",
        "skiAreas": [
          "1",
        ],
      },
      {
        "id": "4",
        "name": "Ski Area 2: Lift",
        "skiAreas": [
          "2",
        ],
      },
    ]
  `);
});

it("merges Skimap.org ski area with OpenStreetMap ski area", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
        geometry: { type: "Point", coordinates: [0, 0] },
      }),
      TestHelpers.mockSkiAreaFeature({
        id: "2",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.SKIMAP_ORG, id: "2" }],
        geometry: { type: "Point", coordinates: [1, 0] },
      }),
    ],
    [
      TestHelpers.mockLiftFeature({
        id: "3",
        name: "Lift",
        liftType: LiftType.TBar,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      }),
    ],
    [],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
      simplifiedSkiAreaFeatureWithSources,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "activities": [
          "downhill",
        ],
        "id": "1",
        "name": "Name",
        "sources": [
          {
            "id": "1",
            "type": "openstreetmap",
          },
          {
            "id": "2",
            "type": "skimap.org",
          },
        ],
      },
    ]
  `);

  expect(
    (await TestHelpers.outputContents(dataStore, "lifts")).features.map(
      simplifiedLiftFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "3",
        "name": "Lift",
        "skiAreas": [
          "1",
        ],
      },
    ]
  `);
});

it("merges Skimap.org ski area into adjacent OpenStreetMap ski areas", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      }),
      TestHelpers.mockSkiAreaFeature({
        id: "2",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "2" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [1, 1],
              [2, 1],
              [2, 2],
              [1, 2],
              [1, 1],
            ],
          ],
        },
      }),
      TestHelpers.mockSkiAreaFeature({
        id: "3",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.SKIMAP_ORG, id: "3" }],
        geometry: { type: "Point", coordinates: [1, 1] },
      }),
    ],
    [
      TestHelpers.mockLiftFeature({
        id: "5",
        name: "Lift",
        liftType: LiftType.TBar,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0.99999],
          ],
        },
      }),
      TestHelpers.mockLiftFeature({
        id: "6",
        name: "Lift",
        liftType: LiftType.TBar,
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 1.00001],
            [2, 1],
          ],
        },
      }),
    ],
    [],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas"))
      .features.map(simplifiedSkiAreaFeatureWithSources)
      .sort(orderedByID),
  ).toMatchInlineSnapshot(`
    [
      {
        "activities": [
          "downhill",
        ],
        "id": "1",
        "name": "Name",
        "sources": [
          {
            "id": "1",
            "type": "openstreetmap",
          },
          {
            "id": "3",
            "type": "skimap.org",
          },
        ],
      },
      {
        "activities": [
          "downhill",
        ],
        "id": "2",
        "name": "Name",
        "sources": [
          {
            "id": "2",
            "type": "openstreetmap",
          },
          {
            "id": "3",
            "type": "skimap.org",
          },
        ],
      },
    ]
  `);
});

it("merges Skimap.org ski area without activities with OpenStreetMap ski area", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
        geometry: { type: "Point", coordinates: [0, 0] },
      }),
      TestHelpers.mockSkiAreaFeature({
        id: "2",
        activities: [],
        sources: [{ type: SourceType.SKIMAP_ORG, id: "2" }],
        geometry: { type: "Point", coordinates: [1, 0] },
      }),
    ],
    [
      TestHelpers.mockLiftFeature({
        id: "3",
        name: "Lift",
        liftType: LiftType.TBar,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      }),
    ],
    [],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
      simplifiedSkiAreaFeatureWithSources,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "activities": [
          "downhill",
        ],
        "id": "1",
        "name": "Name",
        "sources": [
          {
            "id": "1",
            "type": "openstreetmap",
          },
          {
            "id": "2",
            "type": "skimap.org",
          },
        ],
      },
    ]
  `);
});

it("prefers OSM sourced websites when merging Skimap.org ski area with OpenStreetMap ski area", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
        websites: ["https://openstreetmap.org"],
        geometry: { type: "Point", coordinates: [0, 0] },
      }),
      TestHelpers.mockSkiAreaFeature({
        id: "2",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.SKIMAP_ORG, id: "2" }],
        websites: ["https://skimap.org"],
        geometry: { type: "Point", coordinates: [0, 0] },
      }),
    ],
    [],
    [],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
      (feature: SkiAreaFeature) => feature.properties.websites,
    ),
  ).toMatchInlineSnapshot(`
[
  [
    "https://skimap.org",
  ],
]
`);
});

it("removes OpenStreetMap ski areas that span across multiple Skimap.org ski areas", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      }),
      TestHelpers.mockSkiAreaFeature({
        id: "2",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.SKIMAP_ORG, id: "2" }],
        geometry: { type: "Point", coordinates: [0.25, 0.25] },
      }),
      TestHelpers.mockSkiAreaFeature({
        id: "3",
        activities: [SkiAreaActivity.Downhill],
        sources: [{ type: SourceType.SKIMAP_ORG, id: "2" }],
        geometry: { type: "Point", coordinates: [0.75, 0.75] },
      }),
    ],
    [],
    [],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas"))
      .features.map(simplifiedSkiAreaFeature)
      .sort(orderedByID),
  ).toMatchInlineSnapshot(`
    [
      {
        "activities": [
          "downhill",
        ],
        "id": "2",
        "name": "Name",
      },
      {
        "activities": [
          "downhill",
        ],
        "id": "3",
        "name": "Name",
      },
    ]
  `);
});

it("adds activities to OpenStreetMap ski areas based on the associated runs", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      }),
    ],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        name: "Nordic trail",
        geometry: {
          type: "LineString",
          coordinates: [
            [0.0001, 0.0001],
            [0.9999, 0.0001],
          ],
        },
        uses: [RunUse.Nordic],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
      simplifiedSkiAreaFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "activities": [
          "nordic",
        ],
        "id": "1",
        "name": "Name",
      },
    ]
  `);
});

it("removes OpenStreetMap ski area without nearby runs/lifts", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      }),
    ],
    [],
    [],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
      simplifiedSkiAreaFeature,
    ),
  ).toMatchInlineSnapshot(`[]`);
});

it("uses runs fully contained in the ski area polygon to determine activities when they are not known", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      }),
    ],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        geometry: {
          type: "LineString",
          coordinates: [
            [0.5, 0.5],
            [1.5, 1.5],
          ],
        },
        name: "Run extending beyond ski area",
        uses: [RunUse.Nordic],
      }),
      TestHelpers.mockRunFeature({
        id: "3",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        name: "Run within ski area",
        uses: [RunUse.Downhill],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas"))
      .features.map(simplifiedSkiAreaFeature)
      .sort(orderedByID),
  ).toMatchInlineSnapshot(`
    [
      {
        "activities": [
          "downhill",
        ],
        "id": "1",
        "name": "Name",
      },
      {
        "activities": [
          "nordic",
        ],
        "id": "mock-UUID-0",
        "name": null,
      },
    ]
  `);
});

it("removes an OpenStreetMap ski area that does not contain any runs/lifts as it might be representing something other than a ski area", async () => {
  await TestHelpers.mockProcessingFeatures(
    [
      TestHelpers.mockSkiAreaFeature({
        id: "1",
        activities: [],
        sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      }),
    ],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        geometry: {
          type: "LineString",
          coordinates: [
            [1.0001, 1.0001],
            [1.5, 1.5],
          ],
        },
        name: "Run outside the ski area should be associated with a separate, generated ski area",
        uses: [RunUse.Nordic],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "ski_areas")).features.map(
      simplifiedSkiAreaFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "activities": [
          "nordic",
        ],
        "id": "mock-UUID-0",
        "name": null,
      },
    ]
  `);

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "2",
        "name": "Run outside the ski area should be associated with a separate, generated ski area",
        "skiAreas": [
          "mock-UUID-0",
        ],
      },
    ]
  `);
});

it("updates geometry, run convention, and activities for a site based ski area", async () => {

  const siteSkiArea = TestHelpers.mockSkiAreaSiteFeature({
    id: "1",
    osmID: 1,
    activities: [],
    sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
  });
  await TestHelpers.mockProcessingFeatures(
    [siteSkiArea],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        geometry: {
          type: "LineString",
          coordinates: [
            [1.0001, 1.0001],
            [1.5, 1.5],
          ],
        },
        name: "Run",
        uses: [RunUse.Nordic],
        skiAreas: [siteSkiArea],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  const skiAreaFeatures: [SkiAreaFeature] = (await TestHelpers.outputContents(dataStore, "ski_areas")).features as [SkiAreaFeature];

  expect(skiAreaFeatures.length).toBe(1);

  const skiAreaFeature = skiAreaFeatures[0];

  expect(skiAreaFeature.properties.activities).toMatchInlineSnapshot(`
    [
      "nordic",
    ]
  `);

  expect(skiAreaFeature.geometry).toMatchInlineSnapshot(`
{
  "coordinates": [
    1.499363924,
    1.499364027,
    0,
  ],
  "type": "Point",
}
`);
  expect(skiAreaFeature.properties.runConvention).toMatchInlineSnapshot(
    `"europe"`,
  );
  expect(skiAreaFeature.properties.sources).toMatchInlineSnapshot(`
    [
      {
        "id": "1",
        "type": "openstreetmap",
      },
    ]
  `);

  const runSkiAreas = (await TestHelpers.outputContents(dataStore, "runs")).features[0].properties.skiAreas;
  expect(runSkiAreas).toHaveLength(1);
  expect(runSkiAreas[0].properties).toMatchObject(toSkiAreaSummary(skiAreaFeature).properties);
});

it("adds nearby unassociated runs of same activity to site based ski area", async () => {

  const siteSkiArea = TestHelpers.mockSkiAreaSiteFeature({
    id: "1",
    osmID: 1,
    activities: [],
    sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
  });
  await TestHelpers.mockProcessingFeatures(
    [siteSkiArea],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        geometry: {
          type: "LineString",
          coordinates: [
            [1.0001, 1.0001],
            [1.5, 1.5],
          ],
        },
        name: "Run",
        uses: [RunUse.Nordic],
        skiAreas: [siteSkiArea],
      }),
      TestHelpers.mockRunFeature({
        id: "3",
        geometry: {
          type: "LineString",
          coordinates: [
            [2, 2],
            [1.5, 1.5],
          ],
        },
        name: "Run",
        uses: [RunUse.Nordic],
        skiAreas: [],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "2",
        "name": "Run",
        "skiAreas": [
          "1",
        ],
      },
      {
        "id": "3",
        "name": "Run",
        "skiAreas": [
          "1",
        ],
      },
    ]
  `);
});

it("does not add nearby unassociated runs of different activity to site based ski area", async () => {

  const siteSkiArea = TestHelpers.mockSkiAreaSiteFeature({
    id: "1",
    osmID: 1,
    activities: [],
    sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
  });
  await TestHelpers.mockProcessingFeatures(
    [siteSkiArea],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        geometry: {
          type: "LineString",
          coordinates: [
            [1.0001, 1.0001],
            [1.5, 1.5],
          ],
        },
        name: "Run",
        uses: [RunUse.Downhill],
        skiAreas: [siteSkiArea],
      }),
      TestHelpers.mockRunFeature({
        id: "3",
        geometry: {
          type: "LineString",
          coordinates: [
            [2, 2],
            [1.5, 1.5],
          ],
        },
        name: "Run",
        uses: [RunUse.Nordic],
        skiAreas: [],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "id": "2",
        "name": "Run",
        "skiAreas": [
          "1",
        ],
      },
      {
        "id": "3",
        "name": "Run",
        "skiAreas": [
          "mock-UUID-0",
        ],
      },
    ]
  `);
});

it("removes site based ski area that doesn't have associated lifts and runs", async () => {

  const siteSkiArea = TestHelpers.mockSkiAreaSiteFeature({
    id: "1",
    osmID: 1,
    activities: [],
    sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
  });
  await TestHelpers.mockProcessingFeatures([siteSkiArea], [], [], dataStore);

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`[]`);
});

it("removes landuse based ski area when there is a site with sufficient overlap", async () => {

  const siteSkiArea = TestHelpers.mockSkiAreaSiteFeature({
    id: "1",
    osmID: 1,
    activities: [],
    sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
  });
  const landuseSkiArea = TestHelpers.mockSkiAreaFeature({
    sources: [{ type: SourceType.OPENSTREETMAP, id: "2" }],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    },
  });
  await TestHelpers.mockProcessingFeatures(
    [siteSkiArea, landuseSkiArea],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        name: "Run",
        skiAreas: [siteSkiArea],
      }),
      TestHelpers.mockRunFeature({
        id: "3",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
          ],
        },
        name: "Run",
        skiAreas: [siteSkiArea],
      }),
      TestHelpers.mockRunFeature({
        id: "4",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
          ],
        },
        name: "Run",
        // This run is not assigned to the site, but given there are enough nearby ski runs in the site,
        // the landuse based ski area should be removed.
        skiAreas: [],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  const skiAreaFeatures: [SkiAreaFeature] = (await TestHelpers.outputContents(dataStore, "ski_areas")).features as [SkiAreaFeature];

  expect(skiAreaFeatures.length).toBe(1);

  const skiAreaFeature = skiAreaFeatures[0];
  expect(skiAreaFeature.geometry).toMatchInlineSnapshot(`
{
  "coordinates": [
    0.999597754,
    0.999195622,
    0,
  ],
  "type": "Point",
}
`);
  expect(skiAreaFeature.properties.sources).toMatchInlineSnapshot(`
    [
      {
        "id": "1",
        "type": "openstreetmap",
      },
    ]
  `);

  const runSkiAreas = (await TestHelpers.outputContents(dataStore, "runs")).features[0].properties.skiAreas;
  expect(runSkiAreas).toHaveLength(1);
  expect(runSkiAreas[0].properties).toMatchObject(toSkiAreaSummary(skiAreaFeature).properties);
});

it("keeps landuse based ski area when there is a site with insufficient overlap", async () => {

  const siteSkiArea = TestHelpers.mockSkiAreaSiteFeature({
    id: "1",
    osmID: 1,
    activities: [],
    sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
  });
  const landuseSkiArea = TestHelpers.mockSkiAreaFeature({
    sources: [{ type: SourceType.OPENSTREETMAP, id: "2" }],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    },
  });
  await TestHelpers.mockProcessingFeatures(
    [siteSkiArea, landuseSkiArea],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        name: "Run",
        skiAreas: [siteSkiArea],
      }),
      TestHelpers.mockRunFeature({
        id: "3",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
          ],
        },
        name: "Run",
        skiAreas: [siteSkiArea],
      }),
      TestHelpers.mockRunFeature({
        id: "4",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
          ],
        },
        name: "Run",
        skiAreas: [],
      }),
      TestHelpers.mockRunFeature({
        id: "5",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
          ],
        },
        name: "Run",
        skiAreas: [],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  const skiAreaFeatures: [SkiAreaFeature] = (await TestHelpers.outputContents(dataStore, "ski_areas")).features as [SkiAreaFeature];

  expect(skiAreaFeatures.length).toBe(2);

  const runFeatures = (await TestHelpers.outputContents(dataStore, "runs")).features.map(simplifiedRunFeature);

  expect(runFeatures).toMatchInlineSnapshot(`
    [
      {
        "id": "2",
        "name": "Run",
        "skiAreas": [
          "1",
          "ID",
        ],
      },
      {
        "id": "3",
        "name": "Run",
        "skiAreas": [
          "1",
          "ID",
        ],
      },
      {
        "id": "4",
        "name": "Run",
        "skiAreas": [
          "ID",
        ],
      },
      {
        "id": "5",
        "name": "Run",
        "skiAreas": [
          "ID",
        ],
      },
    ]
  `);
});

it("keeps site=piste ski area with only backcountry runs", async () => {

  const siteSkiArea = TestHelpers.mockSkiAreaSiteFeature({
    id: "1",
    activities: [],
    sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
    osmID: 1,
  });
  await TestHelpers.mockProcessingFeatures(
    [siteSkiArea],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        name: "Run",
        uses: [RunUse.Downhill],
        grooming: RunGrooming.Backcountry,
        skiAreas: [siteSkiArea],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  const skiAreaFeatures: [SkiAreaFeature] = (await TestHelpers.outputContents(dataStore, "ski_areas")).features as [SkiAreaFeature];
  expect(skiAreaFeatures.length).toBe(1);
  // Ideally we'd have a separate activity "Backcountry". It's a bit ambiguous though. Maybe it could be based on if a downhill ski area has lifts.
  expect(skiAreaFeatures[0].properties.activities).toEqual([
    SkiAreaActivity.Downhill,
  ]);
});

// Keep limited support for other kinds of winter sports areas when explicitly defined with site=piste ski area.
it("keeps site=piste ski area with only non-skiing activities", async () => {

  const siteSkiArea = TestHelpers.mockSkiAreaSiteFeature({
    id: "1",
    activities: [],
    sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
    osmID: 1,
  });
  await TestHelpers.mockProcessingFeatures(
    [siteSkiArea],
    [],
    [
      TestHelpers.mockRunFeature({
        id: "2",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        name: "Run",
        uses: [RunUse.Sled],
        skiAreas: [siteSkiArea],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  const skiAreaFeatures: [SkiAreaFeature] = (await TestHelpers.outputContents(dataStore, "ski_areas")).features as [SkiAreaFeature];
  expect(skiAreaFeatures.length).toBe(1);
  expect(skiAreaFeatures[0].properties.activities).toEqual([]);
});

function orderedByID(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

it("extends site=piste ski area with nearby runs", async () => {

  const siteSkiArea = TestHelpers.mockSkiAreaSiteFeature({
    id: "1",
    activities: [],
    sources: [{ type: SourceType.OPENSTREETMAP, id: "1" }],
    osmID: 1,
  });

  await TestHelpers.mockProcessingFeatures(
    [siteSkiArea],
    [
      TestHelpers.mockLiftFeature({
        id: "3",
        name: "Lift",
        liftType: LiftType.TBar,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
        skiAreas: [siteSkiArea],
      }),
    ],
    [
      TestHelpers.mockRunFeature({
        id: "4",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        name: "Run",
        uses: [RunUse.Downhill],
        skiAreas: [siteSkiArea],
      }),
      TestHelpers.mockRunFeature({
        id: "5",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0.1],
            [0.9, 0.9],
          ],
        },
        name: "Run",
        uses: [RunUse.Downhill],
        skiAreas: [siteSkiArea],
      }),
      TestHelpers.mockRunFeature({
        id: "6",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [1, 0],
              [2, 0],
              [2, 1],
              [1, 1],
              [1, 0],
            ],
          ],
        },
        name: "Unassigned Run",
        uses: [RunUse.Downhill],
        skiAreas: [],
      }),
    ],
    dataStore,
  );

  await clusterSkiAreas(dataStore, testConfig);

  expect(
    (await TestHelpers.outputContents(dataStore, "runs")).features.map(
      simplifiedRunFeature,
    ),
  ).toMatchInlineSnapshot(`
[
  {
    "id": "4",
    "name": "Run",
    "skiAreas": [
      "1",
    ],
  },
  {
    "id": "5",
    "name": "Run",
    "skiAreas": [
      "1",
    ],
  },
  {
    "id": "6",
    "name": "Unassigned Run",
    "skiAreas": [
      "1",
    ],
  },
]
`);
});
