import {
  LiftType,
  Place,
  RunDifficulty,
  SkiAreaProperties,
  SourceType,
} from "openskidata-format";
import { VIIRSPixel } from "../../utils/VIIRSPixelExtractor";
import {
  LiftObject,
  MapObject,
  MapObjectType,
  RunObject,
  SkiAreaObject,
} from "../MapObject";
import { ObjectRow, SQLParamValue } from "./types";

/**
 * Converts a database row to a MapObject
 */
export function rowToMapObject(row: ObjectRow): MapObject {
  if (row.type === MapObjectType.SkiArea) {
    return {
      _key: row.key,
      _id: row.key,
      id: row.key,
      type: MapObjectType.SkiArea,
      geometry: row.geometry,
      activities: row.activities || [],
      skiAreas: row.ski_areas || [],
      source: row.source as SourceType,
      isPolygon: Boolean(row.is_polygon),
      properties: (row.properties || {}) as SkiAreaProperties,
    } as SkiAreaObject;
  } else if (row.type === MapObjectType.Lift) {
    return {
      _key: row.key,
      _id: row.key,
      type: MapObjectType.Lift,
      geometry: row.geometry,
      geometryWithElevations: row.geometry_with_elevations || row.geometry,
      activities: row.activities || [],
      skiAreas: row.ski_areas || [],
      liftType: (row.lift_type || "unknown") as LiftType,
      isInSkiAreaPolygon: Boolean(row.is_in_ski_area_polygon),
      isInSkiAreaSite: Boolean(row.is_in_ski_area_site),
      properties: (row.properties || { places: [] }) as { places: Place[] },
    } as LiftObject;
  } else {
    // Run type
    return {
      _key: row.key,
      _id: row.key,
      type: MapObjectType.Run,
      geometry: row.geometry,
      geometryWithElevations: row.geometry_with_elevations || row.geometry,
      activities: row.activities || [],
      skiAreas: row.ski_areas || [],
      isBasisForNewSkiArea: Boolean(row.is_basis_for_new_ski_area),
      isInSkiAreaPolygon: Boolean(row.is_in_ski_area_polygon),
      isInSkiAreaSite: Boolean(row.is_in_ski_area_site),
      difficulty: row.difficulty as RunDifficulty | null,
      viirsPixels: row.viirs_pixels || [],
      properties: (row.properties || { places: [] }) as { places: Place[] },
    } as RunObject;
  }
}

/**
 * Converts a MapObject to SQL parameters for insertion/update
 */
export function mapObjectToSQLParams(object: MapObject): SQLParamValue[] {
  const geometryGeoJSON = JSON.stringify(object.geometry);

  // Type-narrowing based on object type
  let source = "unknown";
  let geometryWithElevations = object.geometry;
  let isPolygon = false;
  let isBasisForNewSkiArea = false;
  let isInSkiAreaPolygon = false;
  let isInSkiAreaSite = false;
  let liftType: string | null = null;
  let difficulty: string | null = null;
  let viirsPixels: VIIRSPixel[] = [];
  let properties: Record<string, unknown> = {};

  if (object.type === MapObjectType.SkiArea) {
    const skiArea = object as SkiAreaObject;
    source = skiArea.source;
    isPolygon = skiArea.isPolygon;
    properties = skiArea.properties as unknown as Record<string, unknown>;
  } else if (object.type === MapObjectType.Lift) {
    const lift = object as LiftObject;
    geometryWithElevations = lift.geometryWithElevations;
    isInSkiAreaPolygon = lift.isInSkiAreaPolygon;
    isInSkiAreaSite = lift.isInSkiAreaSite;
    liftType = lift.liftType;
    properties = lift.properties as unknown as Record<string, unknown>;
  } else if (object.type === MapObjectType.Run) {
    const run = object as RunObject;
    geometryWithElevations = run.geometryWithElevations;
    isBasisForNewSkiArea = run.isBasisForNewSkiArea;
    isInSkiAreaPolygon = run.isInSkiAreaPolygon;
    isInSkiAreaSite = run.isInSkiAreaSite;
    difficulty = run.difficulty;
    viirsPixels = run.viirsPixels;
    properties = run.properties as unknown as Record<string, unknown>;
  }

  return [
    object._key,
    object.type,
    source,
    JSON.stringify(object.geometry),
    JSON.stringify(geometryWithElevations),
    geometryGeoJSON,
    isPolygon,
    JSON.stringify(object.activities || []),
    JSON.stringify(object.skiAreas || []),
    isBasisForNewSkiArea,
    isInSkiAreaPolygon,
    isInSkiAreaSite,
    liftType,
    difficulty,
    JSON.stringify(viirsPixels),
    JSON.stringify(properties),
  ];
}

/**
 * Builds update SQL clauses for object field updates
 */
export function buildUpdateClauses(updates: Partial<MapObject>): {
  setParts: string[];
  values: SQLParamValue[];
} {
  const setParts: string[] = [];
  const values: SQLParamValue[] = [];
  let paramIndex = 1;

  Object.entries(updates).forEach(([field, value]) => {
    switch (field) {
      case "geometry":
        const geometryGeoJSON = JSON.stringify(value);
        setParts.push(
          `geometry = $${paramIndex++}`,
          `geom = ST_MakeValid(ST_Force2D(ST_GeomFromGeoJSON($${paramIndex++})), 'method=structure')`,
        );
        values.push(JSON.stringify(value), geometryGeoJSON);
        break;
      case "skiAreas":
        setParts.push(`ski_areas = $${paramIndex++}`);
        values.push(JSON.stringify(value));
        break;
      case "isBasisForNewSkiArea":
        setParts.push(`is_basis_for_new_ski_area = $${paramIndex++}`);
        values.push(value ? true : false);
        break;
      case "isInSkiAreaPolygon":
        setParts.push(`is_in_ski_area_polygon = $${paramIndex++}`);
        values.push(value ? true : false);
        break;
      case "isPolygon":
        setParts.push(`is_polygon = $${paramIndex++}`);
        values.push(value ? true : false);
        break;
      case "activities":
        setParts.push(`activities = $${paramIndex++}`);
        values.push(JSON.stringify(value));
        break;
      case "properties":
        setParts.push(`properties = $${paramIndex++}`);
        values.push(JSON.stringify(value));
        break;
    }
  });

  return { setParts, values };
}
