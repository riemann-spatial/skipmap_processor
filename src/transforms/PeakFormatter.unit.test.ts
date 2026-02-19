import OSMGeoJSONProperties from "../features/OSMGeoJSONProperties";
import { InputPeakFeature, OSMPeakTags } from "../features/PeakFeature";
import { formatPeak } from "./PeakFormatter";

describe("PeakFormatter", () => {
  it("formats simple peak", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 1,
        tags: { natural: "peak", name: "Zugspitze", ele: "2962" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties).toMatchInlineSnapshot(`
{
  "elevation": 2962,
  "elevationSource": "osm",
  "id": "9b0708dd13a3e732ee7d37ea152c6afde32ac2f1",
  "name": "Zugspitze",
  "naturalType": "peak",
  "prominence": null,
  "sources": [
    {
      "id": "node/1",
      "type": "openstreetmap",
    },
  ],
  "type": "peak",
  "websites": [],
  "wikidataID": null,
  "wikipediaID": null,
}
`);
  });

  it("formats volcano", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 2,
        tags: { natural: "volcano", name: "Mount Etna", ele: "3357" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.naturalType).toBe("volcano");
  });

  it("parses elevation with m suffix", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 3,
        tags: { natural: "peak", ele: "1234 m" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.elevation).toBe(1234);
    expect(peaks[0]!.properties.elevationSource).toBe("osm");
  });

  it("parses elevation with meters suffix", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 4,
        tags: { natural: "peak", ele: "1234meters" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.elevation).toBe(1234);
  });

  it("parses elevation with comma decimal separator", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 5,
        tags: { natural: "peak", ele: "1234,5" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.elevation).toBe(1234.5);
  });

  it("rounds elevation to 0.1m", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 6,
        tags: { natural: "peak", ele: "1234.56" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.elevation).toBe(1234.6);
  });

  it("returns null elevation for invalid ele tag", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 7,
        tags: { natural: "peak", ele: "not a number" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.elevation).toBeNull();
    expect(peaks[0]!.properties.elevationSource).toBeNull();
  });

  it("returns null elevation for out-of-range ele (too high)", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 8,
        tags: { natural: "peak", ele: "10000" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.elevation).toBeNull();
  });

  it("returns null elevation for out-of-range ele (too low)", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 9,
        tags: { natural: "peak", ele: "-600" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.elevation).toBeNull();
  });

  it("returns null elevation when ele is missing", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 10,
        tags: { natural: "peak" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.elevation).toBeNull();
    expect(peaks[0]!.properties.elevationSource).toBeNull();
  });

  it("parses prominence", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 11,
        tags: { natural: "peak", ele: "2000", prominence: "500" },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.prominence).toBe(500);
  });

  it("preserves website and wikidata", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 12,
        tags: {
          natural: "peak",
          name: "Test Peak",
          website: "https://example.com",
          wikidata: "Q12345",
          wikipedia: "en:Test Peak",
        },
      }),
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.properties.websites).toEqual(["https://example.com"]);
    expect(peaks[0]!.properties.wikidataID).toBe("Q12345");
    expect(peaks[0]!.properties.wikipediaID).toBe("en:Test Peak");
  });

  it("filters out unsupported natural types", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 13,
        tags: { natural: "tree" },
      }),
    );
    expect(peaks).toEqual([]);
  });

  it("filters out missing natural tag", () => {
    const peaks = formatPeak(
      inputPeak({
        type: "node",
        id: 14,
        tags: {},
      }),
    );
    expect(peaks).toEqual([]);
  });

  it("filters out non-Point geometry", () => {
    const lineFeature = {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      properties: {
        type: "way",
        id: 15,
        tags: { natural: "peak" },
      },
    };

    const peaks = formatPeak(lineFeature as unknown as InputPeakFeature);
    expect(peaks).toEqual([]);
  });
});

function inputPeak(
  properties: OSMGeoJSONProperties<OSMPeakTags>,
): InputPeakFeature {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [11.0, 47.0],
    },
    properties: properties,
  };
}
