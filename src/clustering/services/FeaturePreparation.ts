import { AssertionError } from "assert";
import * as GeoJSON from "geojson";
import {
  LiftFeature,
  LiftGeometry,
  RunFeature,
  RunGeometry,
  RunGrooming,
  RunUse,
  SkiAreaActivity,
  SkiAreaFeature,
  Status,
} from "openskidata-format";
import { SnowCoverConfig } from "../../Config";
import { VIIRSPixelExtractor } from "../../utils/VIIRSPixelExtractor";
import { DraftLift, DraftRun, DraftSkiArea, MapObjectType } from "../MapObject";
import { allSkiAreaActivities } from "../SkiAreaClusteringService";

export function prepareSkiArea(feature: SkiAreaFeature): DraftSkiArea {
  const sources = feature.properties.sources;

  if (sources.length !== 1) {
    throw new AssertionError({
      message:
        "Only ski areas with a single source are supported for clustering.",
    });
  }

  const properties = feature.properties;
  return {
    _key: properties.id,
    id: properties.id,
    source: sources[0].type,
    isPolygon:
      feature.geometry.type === "Polygon" ||
      feature.geometry.type === "MultiPolygon",
    type: MapObjectType.SkiArea,
    geometry: feature.geometry,
    skiAreas: [],
    activities: properties.activities,
    properties: properties,
  };
}

export function prepareLift(feature: LiftFeature): DraftLift {
  const properties = feature.properties;
  return {
    _key: properties.id,
    type: MapObjectType.Lift,
    geometry: geometryWithoutElevations(feature.geometry) as LiftGeometry,
    geometryWithElevations: feature.geometry,
    activities:
      properties["status"] === Status.Operating
        ? [SkiAreaActivity.Downhill]
        : [],
    skiAreas: feature.properties.skiAreas.map(
      (skiArea) => skiArea.properties.id,
    ),
    isInSkiAreaPolygon: false,
    isInSkiAreaSite: feature.properties.skiAreas.length > 0,
    liftType: properties.liftType,
    properties: {
      places: [],
    },
  };
}

export function prepareRun(
  feature: RunFeature,
  viirsExtractor: VIIRSPixelExtractor,
  snowCoverConfig: SnowCoverConfig | null,
): DraftRun {
  const properties = feature.properties;
  const isInSkiAreaSite = feature.properties.skiAreas.length > 0;

  const activities = (() => {
    if (
      !isInSkiAreaSite &&
      properties.grooming === RunGrooming.Backcountry &&
      properties.patrolled !== true
    ) {
      return [];
    }

    return properties.uses.flatMap((use) => {
      switch (use) {
        case RunUse.Downhill:
        case RunUse.SnowPark:
          return [SkiAreaActivity.Downhill];
        case RunUse.Nordic:
          return [SkiAreaActivity.Nordic];
        case RunUse.Skitour:
          return [];
        default:
          return [];
      }
    });
  })();

  const viirsPixels =
    snowCoverConfig !== null
      ? viirsExtractor.getGeometryPixelCoordinates(feature.geometry)
      : [];

  return {
    _key: properties.id,
    type: MapObjectType.Run,
    geometry: geometryWithoutElevations(feature.geometry) as RunGeometry,
    geometryWithElevations: feature.geometry,
    isBasisForNewSkiArea:
      (properties.uses.includes(RunUse.Downhill) ||
        properties.uses.includes(RunUse.Nordic)) &&
      activities.some((activity) => allSkiAreaActivities.has(activity)) &&
      feature.properties.skiAreas.length === 0,
    skiAreas: feature.properties.skiAreas.map(
      (skiArea) => skiArea.properties.id,
    ),
    isInSkiAreaPolygon: false,
    isInSkiAreaSite: isInSkiAreaSite,
    activities: activities,
    difficulty: feature.properties.difficulty,
    viirsPixels: viirsPixels,
    properties: {
      places: [],
    },
  };
}

export function geometryWithoutElevations(
  geometry: GeoJSON.Geometry,
): GeoJSON.Geometry {
  switch (geometry.type) {
    case "Point":
      return {
        type: "Point",
        coordinates: [geometry.coordinates[0], geometry.coordinates[1]],
      };
    case "LineString":
      return {
        type: "LineString",
        coordinates: geometry.coordinates.map((coordinate) => [
          coordinate[0],
          coordinate[1],
        ]),
      };
    case "MultiLineString":
    case "Polygon":
      return {
        type: geometry.type,
        coordinates: geometry.coordinates.map((coordinates) =>
          coordinates.map((coordinate) => [coordinate[0], coordinate[1]]),
        ),
      };
    case "MultiPolygon":
      return {
        type: "MultiPolygon",
        coordinates: geometry.coordinates.map((coordinates) =>
          coordinates.map((coordinatess) =>
            coordinatess.map((coordinatesss) => [
              coordinatesss[0],
              coordinatesss[1],
            ]),
          ),
        ),
      };
    case "GeometryCollection":
      return {
        type: "GeometryCollection",
        geometries: geometry.geometries.map(geometryWithoutElevations),
      };
    case "MultiPoint":
      return {
        type: "MultiPoint",
        coordinates: geometry.coordinates.map((coordinate) => [
          coordinate[0],
          coordinate[1],
        ]),
      };
    default: {
      const _exhaustiveCheck: never = geometry;
      throw new Error(
        "Unsupported geometry type " +
          (_exhaustiveCheck as GeoJSON.Geometry).type,
      );
    }
  }
}
