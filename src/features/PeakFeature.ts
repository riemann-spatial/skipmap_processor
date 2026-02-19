import { Source } from "openskidata-format";
import OSMGeoJSONProperties from "./OSMGeoJSONProperties";

export type OSMPeakTags = {
  [key: string]: string | undefined;

  natural?: string;
  name?: string;
  ele?: string;
  prominence?: string;
  wikidata?: string;
  wikipedia?: string;
  website?: string;
};

export type InputPeakFeature = GeoJSON.Feature<
  GeoJSON.Point,
  OSMGeoJSONProperties<OSMPeakTags>
>;

export type ElevationSource = "osm" | "dem" | null;

export interface PeakProperties {
  type: "peak";
  id: string;
  name: string | null;
  elevation: number | null;
  elevationSource: ElevationSource;
  prominence: number | null;
  naturalType: string;
  sources: Source[];
  websites: string[];
  wikidataID: string | null;
  wikipediaID: string | null;
}

export type PeakFeature = GeoJSON.Feature<GeoJSON.Point, PeakProperties>;
