import { existsSync, mkdirSync } from "fs";
import { FeatureType } from "openskidata-format";
import { join } from "path";
import { ValidationError } from "../errors";

export interface CommonOutputPaths {
  readonly skiAreas: string;
  readonly runs: string;
  readonly lifts: string;
  readonly highways?: string;
}

export class OutputPaths {
  readonly mapboxGL: CommonOutputPaths & { highways: string };
  readonly csv: string;
  readonly geoPackage: string;

  constructor(folder: string) {
    if (!existsSync(folder)) {
      mkdirSync(folder);
    }

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

export function getPath(paths: CommonOutputPaths, featureType: FeatureType) {
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
