import OSMGeoJSONProperties from "../features/OSMGeoJSONProperties";
import {
  InputAlpineHutFeature,
  OSMAlpineHutTags,
} from "../features/AlpineHutFeature";
import { formatAlpineHut } from "./AlpineHutFormatter";

describe("AlpineHutFormatter", () => {
  it("formats simple alpine hut", () => {
    const huts = formatAlpineHut(
      inputAlpineHut({
        type: "node",
        id: 1,
        tags: {
          tourism: "alpine_hut",
          name: "Berliner Hütte",
          ele: "2042",
        },
      }),
    );
    expect(huts).toHaveLength(1);
    expect(huts[0]!.properties).toMatchInlineSnapshot(`
{
  "capacity": null,
  "elevation": 2042,
  "elevationSource": "osm",
  "id": "f0da861d9b857b538ec13f143815c30f410c39bc",
  "name": "Berliner Hütte",
  "openingHours": null,
  "operator": null,
  "phone": null,
  "sources": [
    {
      "id": "node/1",
      "type": "openstreetmap",
    },
  ],
  "type": "alpine_hut",
  "websites": [],
  "wikidataID": null,
  "wikipediaID": null,
}
`);
  });

  it("parses capacity and operator", () => {
    const huts = formatAlpineHut(
      inputAlpineHut({
        type: "node",
        id: 2,
        tags: {
          tourism: "alpine_hut",
          name: "Test Hut",
          capacity: "50",
          operator: "Alpine Club",
        },
      }),
    );
    expect(huts).toHaveLength(1);
    expect(huts[0]!.properties.capacity).toBe(50);
    expect(huts[0]!.properties.operator).toBe("Alpine Club");
  });

  it("parses elevation with m suffix", () => {
    const huts = formatAlpineHut(
      inputAlpineHut({
        type: "node",
        id: 3,
        tags: { tourism: "alpine_hut", ele: "1800 m" },
      }),
    );
    expect(huts).toHaveLength(1);
    expect(huts[0]!.properties.elevation).toBe(1800);
  });

  it("parses elevation with comma decimal separator", () => {
    const huts = formatAlpineHut(
      inputAlpineHut({
        type: "node",
        id: 4,
        tags: { tourism: "alpine_hut", ele: "1800,5" },
      }),
    );
    expect(huts).toHaveLength(1);
    expect(huts[0]!.properties.elevation).toBe(1800.5);
  });

  it("returns null elevation for invalid ele", () => {
    const huts = formatAlpineHut(
      inputAlpineHut({
        type: "node",
        id: 5,
        tags: { tourism: "alpine_hut", ele: "not a number" },
      }),
    );
    expect(huts).toHaveLength(1);
    expect(huts[0]!.properties.elevation).toBeNull();
    expect(huts[0]!.properties.elevationSource).toBeNull();
  });

  it("returns null elevation when ele is missing", () => {
    const huts = formatAlpineHut(
      inputAlpineHut({
        type: "node",
        id: 6,
        tags: { tourism: "alpine_hut" },
      }),
    );
    expect(huts).toHaveLength(1);
    expect(huts[0]!.properties.elevation).toBeNull();
  });

  it("preserves website, wikidata, and wikipedia", () => {
    const huts = formatAlpineHut(
      inputAlpineHut({
        type: "node",
        id: 7,
        tags: {
          tourism: "alpine_hut",
          website: "https://example.com",
          wikidata: "Q12345",
          wikipedia: "de:Berliner Hütte",
        },
      }),
    );
    expect(huts).toHaveLength(1);
    expect(huts[0]!.properties.websites).toEqual(["https://example.com"]);
    expect(huts[0]!.properties.wikidataID).toBe("Q12345");
    expect(huts[0]!.properties.wikipediaID).toBe("de:Berliner Hütte");
  });

  it("filters out non-alpine_hut tourism types", () => {
    const huts = formatAlpineHut(
      inputAlpineHut({
        type: "node",
        id: 8,
        tags: { tourism: "hotel" },
      }),
    );
    expect(huts).toEqual([]);
  });

  it("filters out features without tourism tag", () => {
    const huts = formatAlpineHut(
      inputAlpineHut({
        type: "node",
        id: 9,
        tags: {},
      }),
    );
    expect(huts).toEqual([]);
  });

  it("handles polygon geometry", () => {
    const feature: InputAlpineHutFeature = {
      type: "Feature",
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
      properties: {
        type: "way",
        id: 10,
        tags: { tourism: "alpine_hut", name: "Large Hut" },
      },
    };
    const huts = formatAlpineHut(feature);
    expect(huts).toHaveLength(1);
    expect(huts[0]!.geometry.type).toBe("Polygon");
  });

  it("preserves opening_hours and phone", () => {
    const huts = formatAlpineHut(
      inputAlpineHut({
        type: "node",
        id: 11,
        tags: {
          tourism: "alpine_hut",
          opening_hours: "Jun-Sep",
          phone: "+43 123 456",
        },
      }),
    );
    expect(huts).toHaveLength(1);
    expect(huts[0]!.properties.openingHours).toBe("Jun-Sep");
    expect(huts[0]!.properties.phone).toBe("+43 123 456");
  });
});

function inputAlpineHut(
  properties: OSMGeoJSONProperties<OSMAlpineHutTags>,
): InputAlpineHutFeature {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [11.0, 47.0],
    },
    properties: properties,
  };
}
