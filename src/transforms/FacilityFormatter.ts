import objectHash from "object-hash";
import { SourceType } from "openskidata-format";
import { osmID } from "../features/OSMGeoJSONProperties";
import {
  FacilityFeature,
  FacilityProperties,
  InputFacilityFeature,
  SUPPORTED_AMENITY_TYPES,
  SUPPORTED_SHOP_TYPES,
} from "../features/FacilityFeature";
import notEmpty from "../utils/notEmpty";
import { Omit } from "./Omit";
import {
  getOSMFirstValue,
  getOSMName,
  mapOSMNumber,
  mapOSMString,
} from "./OSMTransforms";

export function formatFacility(
  feature: InputFacilityFeature,
): FacilityFeature[] {
  const tags = feature.properties.tags;

  const facilityType = determineFacilityType(tags);
  if (!facilityType) {
    return [];
  }

  const properties: Omit<FacilityProperties, "id"> = {
    type: "facility",
    name: getOSMName(tags, "name"),
    facilityType,
    openingHours: mapOSMString(tags.opening_hours),
    phone: mapOSMString(tags.phone),
    fee: mapOSMString(tags.fee),
    capacity: mapOSMNumber(tags.capacity),
    access: mapOSMString(tags.access),
    cuisine: mapOSMString(tags.cuisine),
    operator: mapOSMString(tags.operator),
    sources: [
      { type: SourceType.OPENSTREETMAP, id: osmID(feature.properties) },
    ],
    websites: [tags.website].filter(notEmpty),
    wikidataID: getOSMFirstValue(tags, "wikidata"),
    wikipediaID: mapOSMString(tags.wikipedia),
  };

  const id = objectHash({
    type: "Feature",
    properties: {
      type: properties.type,
      facilityType: properties.facilityType,
    },
    geometry: feature.geometry,
  });

  return [
    {
      type: "Feature",
      properties: { ...properties, id },
      geometry: feature.geometry,
    },
  ];
}

function determineFacilityType(
  tags: Record<string, string | undefined>,
): string | null {
  const amenity = tags.amenity;
  if (
    amenity &&
    SUPPORTED_AMENITY_TYPES.includes(
      amenity as (typeof SUPPORTED_AMENITY_TYPES)[number],
    )
  ) {
    return amenity;
  }

  const shop = tags.shop;
  if (
    shop &&
    SUPPORTED_SHOP_TYPES.includes(shop as (typeof SUPPORTED_SHOP_TYPES)[number])
  ) {
    return `shop_${shop}`;
  }

  return null;
}
