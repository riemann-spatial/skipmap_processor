import objectHash from "object-hash";
import { SourceType, Status } from "openskidata-format";
import { osmID } from "../features/OSMGeoJSONProperties";
import {
  HighwayFeature,
  HighwayProperties,
  InputHighwayFeature,
  OSMHighwayTags,
  PRIVATE_ACCESS_VALUES,
  ROAD_TYPES,
  SUPPORTED_HIGHWAY_TYPES,
  WALKWAY_TYPES,
} from "../features/HighwayFeature";
import notEmpty from "../utils/notEmpty";
import { isValidGeometryInFeature } from "./GeoTransforms";
import { Omit } from "./Omit";
import {
  getOSMFirstValue,
  getOSMName,
  mapOSMBoolean,
  mapOSMString,
} from "./OSMTransforms";
import getStatusAndValue from "./Status";

export function formatHighway(feature: InputHighwayFeature): HighwayFeature[] {
  // Only process LineString and MultiLineString geometries
  if (
    feature.geometry.type !== "LineString" &&
    feature.geometry.type !== "MultiLineString"
  ) {
    return [];
  }

  if (!isValidGeometryInFeature(feature)) {
    return [];
  }

  const tags = feature.properties.tags;
  const { status, highwayType } = getStatusAndHighwayType(tags);

  // Filter out non-operating highways or those with unknown status
  if (status === null || status !== Status.Operating) {
    return [];
  }

  // Filter out unsupported highway types
  if (!highwayType || !isSupportedHighwayType(highwayType)) {
    return [];
  }

  // Determine if this is a road or walkway
  const isRoad = isRoadType(highwayType);
  const isWalkway = isWalkwayType(highwayType);

  // Determine if access is private/restricted
  const isPrivate = isPrivateAccess(tags);

  const ref = mapOSMString(tags.ref);
  const properties: Omit<HighwayProperties, "id"> = {
    type: "highway",
    name: getOSMName(tags, "name", null, ref),
    ref: ref,
    highwayType: highwayType,
    isRoad: isRoad,
    isWalkway: isWalkway,
    isPrivate: isPrivate,
    surface: mapOSMString(tags.surface),
    smoothness: mapOSMString(tags.smoothness),
    lit: mapOSMBoolean(tags.lit),
    status: status,
    sources: [
      { type: SourceType.OPENSTREETMAP, id: osmID(feature.properties) },
    ],
    websites: [tags.website].filter(notEmpty),
    wikidataID: getOSMFirstValue(tags, "wikidata"),
    skiAreas: [],
  };

  // Handle MultiLineString by splitting into separate LineString features
  if (feature.geometry.type === "MultiLineString") {
    return feature.geometry.coordinates.map((lineCoords) => {
      const lineGeometry: GeoJSON.LineString = {
        type: "LineString",
        coordinates: lineCoords,
      };
      return buildHighwayFeature(lineGeometry, properties);
    });
  }

  return [buildHighwayFeature(feature.geometry, properties)];
}

function getStatusAndHighwayType(tags: OSMHighwayTags): {
  status: Status | null;
  highwayType: string | null;
} {
  const { status, value: highwayType } = getStatusAndValue(
    "highway",
    tags as { [key: string]: string },
  );

  return { status, highwayType };
}

function isSupportedHighwayType(highwayType: string): boolean {
  return SUPPORTED_HIGHWAY_TYPES.includes(
    highwayType as (typeof SUPPORTED_HIGHWAY_TYPES)[number],
  );
}

function isRoadType(highwayType: string): boolean {
  return ROAD_TYPES.includes(highwayType as (typeof ROAD_TYPES)[number]);
}

function isWalkwayType(highwayType: string): boolean {
  return WALKWAY_TYPES.includes(highwayType as (typeof WALKWAY_TYPES)[number]);
}

function isPrivateAccess(tags: OSMHighwayTags): boolean {
  // Check access tag
  if (tags.access && PRIVATE_ACCESS_VALUES.includes(tags.access)) {
    return true;
  }

  // Check motor_vehicle tag for roads
  if (
    tags.motor_vehicle &&
    PRIVATE_ACCESS_VALUES.includes(tags.motor_vehicle)
  ) {
    return true;
  }

  // Check foot tag for walkways
  if (tags.foot && PRIVATE_ACCESS_VALUES.includes(tags.foot)) {
    return true;
  }

  return false;
}

function buildHighwayFeature(
  geometry: GeoJSON.LineString,
  properties: Omit<HighwayProperties, "id">,
): HighwayFeature {
  const id = objectHash({
    type: "Feature",
    properties: {
      type: properties.type,
    },
    geometry: geometry,
  });

  return {
    type: "Feature",
    properties: { ...properties, id: id },
    geometry: geometry,
  };
}
