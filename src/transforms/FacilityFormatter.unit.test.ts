import OSMGeoJSONProperties from "../features/OSMGeoJSONProperties";
import {
  InputFacilityFeature,
  OSMFacilityTags,
} from "../features/FacilityFeature";
import { formatFacility } from "./FacilityFormatter";

describe("FacilityFormatter", () => {
  it("formats parking amenity", () => {
    const facilities = formatFacility(
      inputFacility({
        type: "node",
        id: 1,
        tags: { amenity: "parking", name: "Ski Parking", capacity: "200" },
      }),
    );
    expect(facilities).toHaveLength(1);
    expect(facilities[0]!.properties.facilityType).toBe("parking");
    expect(facilities[0]!.properties.name).toBe("Ski Parking");
    expect(facilities[0]!.properties.capacity).toBe(200);
  });

  it("formats restaurant amenity", () => {
    const facilities = formatFacility(
      inputFacility({
        type: "node",
        id: 2,
        tags: {
          amenity: "restaurant",
          name: "Mountain Restaurant",
          cuisine: "italian",
          opening_hours: "Mo-Su 10:00-22:00",
        },
      }),
    );
    expect(facilities).toHaveLength(1);
    expect(facilities[0]!.properties.facilityType).toBe("restaurant");
    expect(facilities[0]!.properties.cuisine).toBe("italian");
    expect(facilities[0]!.properties.openingHours).toBe("Mo-Su 10:00-22:00");
  });

  it("formats cafe amenity", () => {
    const facilities = formatFacility(
      inputFacility({
        type: "node",
        id: 3,
        tags: { amenity: "cafe", name: "Summit Cafe" },
      }),
    );
    expect(facilities).toHaveLength(1);
    expect(facilities[0]!.properties.facilityType).toBe("cafe");
  });

  it("formats toilets amenity", () => {
    const facilities = formatFacility(
      inputFacility({
        type: "node",
        id: 4,
        tags: { amenity: "toilets", fee: "yes", access: "public" },
      }),
    );
    expect(facilities).toHaveLength(1);
    expect(facilities[0]!.properties.facilityType).toBe("toilets");
    expect(facilities[0]!.properties.fee).toBe("yes");
    expect(facilities[0]!.properties.access).toBe("public");
  });

  it("formats first_aid amenity", () => {
    const facilities = formatFacility(
      inputFacility({
        type: "node",
        id: 5,
        tags: {
          amenity: "first_aid",
          name: "Ski Patrol",
          phone: "+43 123 456",
        },
      }),
    );
    expect(facilities).toHaveLength(1);
    expect(facilities[0]!.properties.facilityType).toBe("first_aid");
    expect(facilities[0]!.properties.phone).toBe("+43 123 456");
  });

  it("formats ski_rental amenity", () => {
    const facilities = formatFacility(
      inputFacility({
        type: "node",
        id: 6,
        tags: {
          amenity: "ski_rental",
          name: "Rent-a-Ski",
          operator: "Sport Shop",
        },
      }),
    );
    expect(facilities).toHaveLength(1);
    expect(facilities[0]!.properties.facilityType).toBe("ski_rental");
    expect(facilities[0]!.properties.operator).toBe("Sport Shop");
  });

  it("formats shop=ski", () => {
    const facilities = formatFacility(
      inputFacility({
        type: "node",
        id: 7,
        tags: {
          shop: "ski",
          name: "Ski Pro Shop",
          website: "https://example.com",
        },
      }),
    );
    expect(facilities).toHaveLength(1);
    expect(facilities[0]!.properties.facilityType).toBe("shop_ski");
    expect(facilities[0]!.properties.websites).toEqual(["https://example.com"]);
  });

  it("preserves wikidata and wikipedia", () => {
    const facilities = formatFacility(
      inputFacility({
        type: "node",
        id: 8,
        tags: {
          amenity: "restaurant",
          wikidata: "Q12345",
          wikipedia: "en:Test Restaurant",
        },
      }),
    );
    expect(facilities).toHaveLength(1);
    expect(facilities[0]!.properties.wikidataID).toBe("Q12345");
    expect(facilities[0]!.properties.wikipediaID).toBe("en:Test Restaurant");
  });

  it("filters out unsupported amenity types", () => {
    const facilities = formatFacility(
      inputFacility({
        type: "node",
        id: 9,
        tags: { amenity: "bank" },
      }),
    );
    expect(facilities).toEqual([]);
  });

  it("filters out features without amenity or shop tag", () => {
    const facilities = formatFacility(
      inputFacility({
        type: "node",
        id: 10,
        tags: {},
      }),
    );
    expect(facilities).toEqual([]);
  });

  it("handles polygon geometry", () => {
    const feature: InputFacilityFeature = {
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
        id: 11,
        tags: { amenity: "parking", name: "Large Parking" },
      },
    };
    const facilities = formatFacility(feature);
    expect(facilities).toHaveLength(1);
    expect(facilities[0]!.geometry.type).toBe("Polygon");
  });
});

function inputFacility(
  properties: OSMGeoJSONProperties<OSMFacilityTags>,
): InputFacilityFeature {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [11.0, 47.0],
    },
    properties: properties,
  };
}
