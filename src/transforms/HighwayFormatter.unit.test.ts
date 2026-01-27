import OSMGeoJSONProperties from "../features/OSMGeoJSONProperties";
import {
  InputHighwayFeature,
  OSMHighwayTags,
} from "../features/HighwayFeature";
import { formatHighway } from "./HighwayFormatter";

describe("HighwayFormatter", () => {
  it("formats simple road", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 1,
        tags: { highway: "residential" },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties).toMatchInlineSnapshot(`
{
  "highwayType": "residential",
  "id": "aff4d5319959db7419306c4f8253d31abc91e1bb",
  "isPrivate": false,
  "isRoad": true,
  "isWalkway": false,
  "lit": null,
  "name": null,
  "ref": null,
  "skiAreas": [],
  "smoothness": null,
  "sources": [
    {
      "id": "way/1",
      "type": "openstreetmap",
    },
  ],
  "status": "operating",
  "surface": null,
  "type": "highway",
  "websites": [],
  "wikidataID": null,
}
`);
  });

  it("formats simple walkway (footway)", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 2,
        tags: { highway: "footway" },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.isRoad).toBe(false);
    expect(highways[0]!.properties.isWalkway).toBe(true);
    expect(highways[0]!.properties.highwayType).toBe("footway");
  });

  it("formats path as walkway", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 3,
        tags: { highway: "path" },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.isRoad).toBe(false);
    expect(highways[0]!.properties.isWalkway).toBe(true);
  });

  it("detects private access from access tag", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 4,
        tags: { highway: "residential", access: "private" },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.isPrivate).toBe(true);
  });

  it("detects private access from access=no tag", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 5,
        tags: { highway: "service", access: "no" },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.isPrivate).toBe(true);
  });

  it("detects private access from motor_vehicle tag", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 6,
        tags: { highway: "residential", motor_vehicle: "private" },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.isPrivate).toBe(true);
  });

  it("detects private access from foot tag", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 7,
        tags: { highway: "footway", foot: "private" },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.isPrivate).toBe(true);
  });

  it("preserves name and ref", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 8,
        tags: {
          highway: "primary",
          name: "Main Street",
          ref: "A1",
        },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.name).toBe("Main Street");
    expect(highways[0]!.properties.ref).toBe("A1");
  });

  it("preserves surface and smoothness", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 9,
        tags: {
          highway: "track",
          surface: "gravel",
          smoothness: "bad",
        },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.surface).toBe("gravel");
    expect(highways[0]!.properties.smoothness).toBe("bad");
  });

  it("preserves lit attribute", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 10,
        tags: {
          highway: "residential",
          lit: "yes",
        },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.lit).toBe(true);
  });

  it("filters out proposed highways", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 11,
        tags: { "proposed:highway": "residential" },
      }),
    );
    expect(highways).toEqual([]);
  });

  it("filters out construction highways", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 12,
        tags: { "construction:highway": "primary" },
      }),
    );
    expect(highways).toEqual([]);
  });

  it("filters out unsupported highway types", () => {
    // bus_stop is not in SUPPORTED_HIGHWAY_TYPES
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 13,
        tags: { highway: "bus_stop" },
      }),
    );
    expect(highways).toEqual([]);
  });

  it("classifies motorway as road", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 14,
        tags: { highway: "motorway" },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.isRoad).toBe(true);
    expect(highways[0]!.properties.isWalkway).toBe(false);
  });

  it("classifies steps as walkway", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 15,
        tags: { highway: "steps" },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.isRoad).toBe(false);
    expect(highways[0]!.properties.isWalkway).toBe(true);
  });

  it("classifies cycleway as walkway", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 16,
        tags: { highway: "cycleway" },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.isRoad).toBe(false);
    expect(highways[0]!.properties.isWalkway).toBe(true);
  });

  it("splits MultiLineString into separate LineString features", () => {
    const multiLineStringFeature: InputHighwayFeature = {
      type: "Feature",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [2, 2],
            [3, 3],
          ],
        ],
      },
      properties: {
        type: "way",
        id: 17,
        tags: {
          highway: "residential",
          name: "Split Road",
        },
      },
    };

    const highways = formatHighway(multiLineStringFeature);
    expect(highways).toHaveLength(2);
    expect(highways.every((h) => h.geometry.type === "LineString")).toBe(true);
    expect(highways[0]!.properties.name).toBe("Split Road");
    expect(highways[1]!.properties.name).toBe("Split Road");
  });

  it("filters out Point geometry", () => {
    const pointFeature = {
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: [0, 0],
      },
      properties: {
        type: "node",
        id: 18,
        tags: { highway: "crossing" },
      },
    };

    // TypeScript will complain because Point is not a valid InputHighwayGeometry,
    // but we test it to ensure runtime filtering works
    const highways = formatHighway(
      pointFeature as unknown as InputHighwayFeature,
    );
    expect(highways).toEqual([]);
  });

  it("preserves website and wikidata", () => {
    const highways = formatHighway(
      inputHighway({
        type: "way",
        id: 19,
        tags: {
          highway: "pedestrian",
          name: "Market Square",
          website: "https://example.com",
          wikidata: "Q12345",
        },
      }),
    );
    expect(highways).toHaveLength(1);
    expect(highways[0]!.properties.websites).toEqual(["https://example.com"]);
    expect(highways[0]!.properties.wikidataID).toBe("Q12345");
  });
});

function inputHighway(
  properties: OSMGeoJSONProperties<OSMHighwayTags>,
): InputHighwayFeature {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    properties: properties,
  };
}
