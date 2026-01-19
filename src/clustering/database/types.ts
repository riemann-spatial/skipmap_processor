import { SkiAreaActivity } from "openskidata-format";
import { VIIRSPixel } from "../../utils/VIIRSPixelExtractor";

/**
 * Type for SQL parameter values
 */
export type SQLParamValue = string | number | boolean | null;

/**
 * Interface for database row returned from objects table
 */
export interface ObjectRow {
  key: string;
  type: string;
  source: string;
  geometry: GeoJSON.Geometry;
  geometry_with_elevations: GeoJSON.Geometry | null;
  is_polygon: boolean;
  activities: SkiAreaActivity[];
  ski_areas: string[];
  is_basis_for_new_ski_area: boolean;
  is_in_ski_area_polygon: boolean;
  is_in_ski_area_site: boolean;
  lift_type: string | null;
  difficulty: string | null;
  viirs_pixels: VIIRSPixel[];
  properties: Record<string, unknown>;
}

/**
 * Interface for PostgreSQL error with code property
 */
export interface PostgresError extends Error {
  code?: string;
}
