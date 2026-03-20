import objectHash from "object-hash";
import { SourceType } from "openskidata-format";
import { osmID } from "../features/OSMGeoJSONProperties";
import {
  AlpineHutFeature,
  AlpineHutProperties,
  ElevationSource,
  InputAlpineHutFeature,
} from "../features/AlpineHutFeature";
import notEmpty from "../utils/notEmpty";
import { Omit } from "./Omit";
import {
  getOSMFirstValue,
  getOSMName,
  mapOSMNumber,
  mapOSMString,
} from "./OSMTransforms";

export function formatAlpineHut(
  feature: InputAlpineHutFeature,
): AlpineHutFeature[] {
  const tags = feature.properties.tags;

  if (tags.tourism !== "alpine_hut") {
    return [];
  }

  const { elevation, elevationSource } = parseElevation(tags.ele);

  const properties: Omit<AlpineHutProperties, "id"> = {
    type: "alpine_hut",
    name: getOSMName(tags, "name"),
    elevation,
    elevationSource,
    capacity: mapOSMNumber(tags.capacity),
    operator: mapOSMString(tags.operator),
    openingHours: mapOSMString(tags.opening_hours),
    phone: mapOSMString(tags.phone),
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

  let cleaned = ele.trim();
  cleaned = cleaned.replace(/\s*(m|meters|metre|metres|meter)\s*$/i, "");
  cleaned = cleaned.replace(",", ".");

  const value = Number(cleaned);
  if (isNaN(value)) {
    return { elevation: null, elevationSource: null };
  }

  if (value < -500 || value > 9000) {
    return { elevation: null, elevationSource: null };
  }

  const rounded = Math.round(value * 10) / 10;
  return { elevation: rounded, elevationSource: "osm" };
}
