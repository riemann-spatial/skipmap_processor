import { existsSync, mkdirSync } from "fs";
import { FeatureType } from "openskidata-format";
import { join } from "path";
import { ValidationError } from "../errors";

export interface CommonGeoJSONPaths {
  readonly skiAreas: string;
  readonly runs: string;
  readonly lifts: string;
  readonly highways?: string;
}

export class GeoJSONIntermediatePaths {
  readonly skiAreas: string;
  readonly runs: string;
  readonly lifts: string;
  readonly highways: string;

  constructor(folder: string) {
    if (!existsSync(folder)) {
      mkdirSync(folder);
    }
    this.skiAreas = join(folder, "intermediate_ski_areas.geojson");
    this.runs = join(folder, "intermediate_runs.geojson");
    this.lifts = join(folder, "intermediate_lifts.geojson");
    this.highways = join(folder, "intermediate_highways.geojson");
  }
}

export class GeoJSONOutputPaths implements CommonGeoJSONPaths {
  readonly skiAreas: string;
  readonly runs: string;
  readonly lifts: string;
  readonly highways: string;

  readonly mapboxGL: CommonGeoJSONPaths & { highways: string };
  readonly csv: string;
  readonly geoPackage: string;

  constructor(folder: string) {
    if (!existsSync(folder)) {
      mkdirSync(folder);
    }

    this.skiAreas = join(folder, "ski_areas.geojson");
    this.runs = join(folder, "runs.geojson");
    this.lifts = join(folder, "lifts.geojson");
    this.highways = join(folder, "highways.geojson");
    this.mapboxGL = {
      skiAreas: join(folder, "mapboxgl_ski_areas.geojson"),
      runs: join(folder, "mapboxgl_runs.geojson"),
      lifts: join(folder, "mapboxgl_lifts.geojson"),
      highways: join(folder, "mapboxgl_highways.geojson"),
    };
    this.csv = join(folder, "csv");
    if (!existsSync(this.csv)) {
      mkdirSync(this.csv);
    }
    this.geoPackage = join(folder, "openskidata.gpkg");
  }
}
export interface DataPaths {
  intermediate: GeoJSONIntermediatePaths;
  output: GeoJSONOutputPaths;
}

export function getPath(paths: CommonGeoJSONPaths, featureType: FeatureType) {
  switch (featureType) {
    case FeatureType.SkiArea:
      return paths.skiAreas;
    case FeatureType.Run:
      return paths.runs;
    case FeatureType.Lift:
      return paths.lifts;
  }

  throw new ValidationError("Unhandled feature type", "featureType");
}
