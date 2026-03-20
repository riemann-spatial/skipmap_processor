import { Source } from "openskidata-format";
import OSMGeoJSONProperties from "./OSMGeoJSONProperties";

export type OSMFacilityTags = {
  [key: string]: string | undefined;

  amenity?: string;
  shop?: string;
  name?: string;
  opening_hours?: string;
  phone?: string;
  fee?: string;
  capacity?: string;
  access?: string;
  cuisine?: string;
  operator?: string;
  wikidata?: string;
  wikipedia?: string;
  website?: string;
};

export const SUPPORTED_AMENITY_TYPES = [
  "parking",
  "restaurant",
  "cafe",
  "toilets",
  "first_aid",
  "ski_rental",
] as const;

export const SUPPORTED_SHOP_TYPES = ["ski"] as const;

export type InputFacilityFeature = GeoJSON.Feature<
  GeoJSON.Geometry,
  OSMGeoJSONProperties<OSMFacilityTags>
>;

export interface FacilityProperties {
  type: "facility";
  id: string;
  name: string | null;
  facilityType: string;
  openingHours: string | null;
  phone: string | null;
  fee: string | null;
  capacity: number | null;
  access: string | null;
  cuisine: string | null;
  operator: string | null;
  sources: Source[];
  websites: string[];
  wikidataID: string | null;
  wikipediaID: string | null;
}

export type FacilityFeature = GeoJSON.Feature<
  GeoJSON.Geometry,
  FacilityProperties
>;
