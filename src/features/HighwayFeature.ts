import { Source, Status } from "openskidata-format";
import OSMGeoJSONProperties from "./OSMGeoJSONProperties";

export type OSMHighwayTags = {
  [key: string]: string | undefined;

  highway?: string;
  access?: string;
  foot?: string;
  motor_vehicle?: string;
  bicycle?: string;
  name?: string;
  ref?: string;
  surface?: string;
  smoothness?: string;
  lit?: string;
  website?: string;
  wikidata?: string;

  // Status-related tags
  "disused:highway"?: string;
  "abandoned:highway"?: string;
  "proposed:highway"?: string;
  "construction:highway"?: string;
};

// Road types (motor vehicles typically allowed)
export const ROAD_TYPES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "service",
  "track",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
] as const;

// Walkway types (pedestrians/cyclists)
export const WALKWAY_TYPES = [
  "footway",
  "path",
  "pedestrian",
  "steps",
  "bridleway",
  "cycleway",
  "corridor",
  "sidewalk",
] as const;

// All supported highway types
export const SUPPORTED_HIGHWAY_TYPES = [...ROAD_TYPES, ...WALKWAY_TYPES];

// Access values that indicate private/restricted access
export const PRIVATE_ACCESS_VALUES = ["private", "no", "customers", "delivery"];

export type RoadType = (typeof ROAD_TYPES)[number];
export type WalkwayType = (typeof WALKWAY_TYPES)[number];
export type HighwayType = RoadType | WalkwayType;

export type InputHighwayGeometry = GeoJSON.LineString | GeoJSON.MultiLineString;

export type InputHighwayFeature = GeoJSON.Feature<
  InputHighwayGeometry,
  OSMGeoJSONProperties<OSMHighwayTags>
>;

export interface HighwayProperties {
  type: "highway";
  id: string;
  name: string | null;
  ref: string | null;
  highwayType: string;
  isRoad: boolean;
  isWalkway: boolean;
  isPrivate: boolean;
  surface: string | null;
  smoothness: string | null;
  lit: boolean | null;
  status: Status;
  sources: Source[];
  websites: string[];
  wikidataID: string | null;
  skiAreas: SkiAreaReference[];
}

export interface SkiAreaReference {
  properties: {
    id: string;
    name: string | null;
  };
}

export type HighwayFeature = GeoJSON.Feature<
  GeoJSON.LineString | GeoJSON.MultiLineString,
  HighwayProperties
>;

export type MapboxGLHighwayProperties = {
  id: string;
  name: string | null;
  highwayType: string;
  isRoad: boolean;
  isWalkway: boolean;
  isPrivate: boolean;
  skiAreas: string[];
};

export type MapboxGLHighwayFeature = GeoJSON.Feature<
  GeoJSON.LineString | GeoJSON.MultiLineString,
  MapboxGLHighwayProperties
>;
