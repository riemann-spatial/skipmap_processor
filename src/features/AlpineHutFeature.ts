import { Source } from "openskidata-format";
import OSMGeoJSONProperties from "./OSMGeoJSONProperties";

export type OSMAlpineHutTags = {
  [key: string]: string | undefined;

  tourism?: string;
  name?: string;
  ele?: string;
  capacity?: string;
  operator?: string;
  opening_hours?: string;
  phone?: string;
  wikidata?: string;
  wikipedia?: string;
  website?: string;
};

export type InputAlpineHutFeature = GeoJSON.Feature<
  GeoJSON.Geometry,
  OSMGeoJSONProperties<OSMAlpineHutTags>
>;

export type ElevationSource = "osm" | "dem" | null;

export interface AlpineHutProperties {
  type: "alpine_hut";
  id: string;
  name: string | null;
  elevation: number | null;
  elevationSource: ElevationSource;
  capacity: number | null;
  operator: string | null;
  openingHours: string | null;
  phone: string | null;
  sources: Source[];
  websites: string[];
  wikidataID: string | null;
  wikipediaID: string | null;
}

export type AlpineHutFeature = GeoJSON.Feature<
  GeoJSON.Geometry,
  AlpineHutProperties
>;
