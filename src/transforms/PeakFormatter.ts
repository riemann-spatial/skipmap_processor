import objectHash from "object-hash";
import { SourceType } from "openskidata-format";
import { osmID } from "../features/OSMGeoJSONProperties";
import {
  ElevationSource,
  InputPeakFeature,
  PeakFeature,
  PeakProperties,
} from "../features/PeakFeature";
import notEmpty from "../utils/notEmpty";
import { Omit } from "./Omit";
import {
  getOSMFirstValue,
  getOSMName,
  mapOSMNumber,
  mapOSMString,
} from "./OSMTransforms";

const SUPPORTED_NATURAL_TYPES = ["peak", "volcano"] as const;

export function formatPeak(feature: InputPeakFeature): PeakFeature[] {
  if (feature.geometry.type !== "Point") {
    return [];
  }

  const tags = feature.properties.tags;
  const naturalType = tags.natural;

  if (
    !naturalType ||
    !SUPPORTED_NATURAL_TYPES.includes(
      naturalType as (typeof SUPPORTED_NATURAL_TYPES)[number],
    )
  ) {
    return [];
  }

  const { elevation, elevationSource } = parseElevation(tags.ele);
  const prominence = mapOSMNumber(tags.prominence);

  const properties: Omit<PeakProperties, "id"> = {
    type: "peak",
    name: getOSMName(tags, "name"),
    elevation,
    elevationSource,
    prominence,
    naturalType,
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

function parseElevation(ele: string | undefined): {
  elevation: number | null;
  elevationSource: ElevationSource;
} {
  if (ele === undefined || ele === "") {
    return { elevation: null, elevationSource: null };
  }

  // Strip common suffixes and whitespace
  let cleaned = ele.trim();
  cleaned = cleaned.replace(/\s*(m|meters|metre|metres|meter)\s*$/i, "");
  // Replace commas used as decimal separators (e.g. "1234,5")
  cleaned = cleaned.replace(",", ".");

  const value = Number(cleaned);
  if (isNaN(value)) {
    return { elevation: null, elevationSource: null };
  }

  // Validate reasonable elevation range
  if (value < -500 || value > 9000) {
    return { elevation: null, elevationSource: null };
  }

  // Round to 0.1m
  const rounded = Math.round(value * 10) / 10;
  return { elevation: rounded, elevationSource: "osm" };
}
