import * as fs from "fs";
import {
  FeatureType,
  LiftFeature,
  LiftGeometry,
  LiftProperties,
  LiftType,
  Place,
  RunDifficulty,
  RunDifficultyConvention,
  RunFeature,
  RunGrooming,
  RunProperties,
  RunUse,
  SkiAreaActivity,
  SkiAreaFeature,
  SkiAreaProperties,
  SkiAreaStatistics,
  Source,
  SourceType,
  Status,
} from "openskidata-format";
import * as path from "path";
import * as tmp from "tmp";
import { SkiAreaGeometry } from "./clustering/MapObject";
import { InputLiftFeature } from "./features/LiftFeature";
import { InputRunFeature, InputRunGeometry } from "./features/RunFeature";
import {
  InputOpenStreetMapSkiAreaFeature,
  InputSkiMapOrgSkiAreaFeature,
  OSMSkiAreaSite,
} from "./features/SkiAreaFeature";
import {
  DataPaths,
  GeoJSONIntermediatePaths,
  GeoJSONOutputPaths,
} from "./io/GeoJSONFiles";
import {
  InputFeature,
  InputSkiAreaFeature,
  InputSkiAreaSite,
  PostGISDataStore,
} from "./io/PostGISDataStore";
import placeholderSiteGeometry from "./utils/PlaceholderSiteGeometry";

export interface FolderContents extends Map<string, any> {}

export function getFilePaths(): DataPaths {
  const dir = tmp.dirSync().name;
  return {
    intermediate: new GeoJSONIntermediatePaths(path.join(dir, "intermediate")),
    output: new GeoJSONOutputPaths(path.join(dir, "output")),
  };
}

/**
 * Creates a unique temporary working directory for tests.
 * Each call returns a new, isolated directory to prevent test interference.
 */
export function getTempWorkingDir(): string {
  return tmp.dirSync().name;
}

function geoJSONFeatureToInputFeature(feature: GeoJSON.Feature): InputFeature {
  const props = feature.properties || {};
  return {
    osm_id: props.id || 0,
    osm_type: props.type || "unknown",
    geometry: feature.geometry,
    properties: props,
  };
}

export async function mockInputFiles(
  input: {
    skiMapSkiAreas: InputSkiMapOrgSkiAreaFeature[];
    openStreetMapSkiAreas: InputOpenStreetMapSkiAreaFeature[];
    openStreetMapSkiAreaSites: OSMSkiAreaSite[];
    lifts: InputLiftFeature[];
    runs: InputRunFeature[];
  },
  dataStore: PostGISDataStore,
): Promise<void> {
  await dataStore.resetInputTables();

  // Store runs
  const runFeatures = input.runs.map((f) => geoJSONFeatureToInputFeature(f));
  if (runFeatures.length > 0) {
    await dataStore.saveInputRuns(runFeatures);
  }

  // Store lifts
  const liftFeatures = input.lifts.map((f) => geoJSONFeatureToInputFeature(f));
  if (liftFeatures.length > 0) {
    await dataStore.saveInputLifts(liftFeatures);
  }

  // Store OSM ski areas
  const osmSkiAreaFeatures: InputSkiAreaFeature[] =
    input.openStreetMapSkiAreas.map((f) => ({
      ...geoJSONFeatureToInputFeature(f),
      source: "openstreetmap" as const,
    }));
  // Store skimap.org ski areas
  const skiMapFeatures: InputSkiAreaFeature[] = input.skiMapSkiAreas.map(
    (f) => ({
      osm_id:
        typeof f.id === "number"
          ? f.id
          : parseInt(String(f.id), 10) ||
            parseInt(String(f.properties?.id), 10) ||
            0,
      osm_type: "skimap",
      geometry: f.geometry,
      properties: (f.properties || {}) as unknown as Record<string, unknown>,
      source: "skimap" as const,
    }),
  );
  const allSkiAreas = [...osmSkiAreaFeatures, ...skiMapFeatures];
  if (allSkiAreas.length > 0) {
    await dataStore.saveInputSkiAreas(allSkiAreas);
  }

  // Store ski area sites
  const sites: InputSkiAreaSite[] = input.openStreetMapSkiAreaSites.map(
    (site) => ({
      osm_id: site.id,
      properties: (site.tags || {}) as Record<string, unknown>,
      members: (site.members || [])
        .filter((m) => m.type === "way" || m.type === "node")
        .map((m) => ({ type: m.type, ref: m.ref })),
    }),
  );
  if (sites.length > 0) {
    await dataStore.saveInputSkiAreaSites(sites);
  }
}

export function mockFeatureFiles(
  skiAreas: SkiAreaFeature[],
  lifts: LiftFeature[],
  runs: RunFeature[],
  intermedatePaths: GeoJSONIntermediatePaths,
) {
  fs.writeFileSync(
    intermedatePaths.skiAreas,
    JSON.stringify({
      type: "FeatureCollection",
      features: skiAreas,
    }),
  );
  fs.writeFileSync(
    intermedatePaths.lifts,
    JSON.stringify({
      type: "FeatureCollection",
      features: lifts,
    }),
  );
  fs.writeFileSync(
    intermedatePaths.runs,
    JSON.stringify({
      type: "FeatureCollection",
      features: runs,
    }),
  );
}

export function contents(paths: GeoJSONOutputPaths): FolderContents {
  return [
    paths.lifts,
    paths.mapboxGL.lifts,
    paths.mapboxGL.runs,
    paths.mapboxGL.skiAreas,
    paths.runs,
    paths.skiAreas,
  ]
    .filter((path) => fs.existsSync(path))
    .reduce((contents: FolderContents, filePath: string) => {
      contents.set("output/" + path.basename(filePath), fileContents(filePath));
      return contents;
    }, new Map());
}

export function fileContents(path: string): any {
  return JSON.parse(fs.readFileSync(path).toString());
}

export function mockRunFeature<G extends InputRunGeometry>(options: {
  id: string;
  name?: string | null;
  oneway?: boolean | null;
  patrolled?: boolean | null;
  ref?: string | null;
  grooming?: RunGrooming | null;
  uses?: RunUse[];
  difficulty?: RunDifficulty;
  difficultyConvention?: RunDifficultyConvention;
  websites?: string[];
  wikidataID?: string | null;
  geometry: G;
  skiAreas?: SkiAreaFeature[];
  status?: Status;
  sources?: Source[];
  places?: Place[];
}): GeoJSON.Feature<G, RunProperties> {
  return {
    type: "Feature",
    properties: {
      type: FeatureType.Run,
      uses: options.uses || [RunUse.Downhill],
      id: options.id,
      name: options.name || null,
      difficulty: options.difficulty || null,
      difficultyConvention:
        options.difficultyConvention || RunDifficultyConvention.EUROPE,
      ref: options.ref || null,
      oneway: options.oneway !== undefined ? options.oneway : null,
      lit: null,
      description: null,
      gladed: null,
      patrolled: options.patrolled !== undefined ? options.patrolled : null,
      grooming: options.grooming || null,
      skiAreas: options.skiAreas || [],
      elevationProfile: null,
      status: options.status || Status.Operating,
      sources: options.sources || [],
      websites: options.websites || [],
      wikidataID: options.wikidataID || null,
      places: options.places || [],
    },
    geometry: options.geometry,
  };
}

export function mockLiftFeature<G extends LiftGeometry>(options: {
  id: string;
  name: string;
  liftType: LiftType;
  status?: Status;
  ref?: string | null;
  refFRCAIRN?: string | null;
  websites?: string[];
  wikidataID?: string | null;
  geometry: G;
  skiAreas?: SkiAreaFeature[];
  sources?: Source[];
  places?: Place[];
}): GeoJSON.Feature<G, LiftProperties> {
  return {
    type: "Feature",
    properties: {
      type: FeatureType.Lift,
      id: options.id,
      name: options.name,
      liftType: options.liftType,
      status: options.status || Status.Operating,
      ref: options.ref || null,
      refFRCAIRN: options.refFRCAIRN || null,
      description: null,
      oneway: null,
      occupancy: null,
      capacity: null,
      duration: null,
      bubble: null,
      heating: null,
      detachable: null,
      skiAreas: options.skiAreas || [],
      sources: options.sources || [],
      websites: options.websites || [],
      wikidataID: options.wikidataID || null,
      places: options.places || [],
    },
    geometry: options.geometry,
  };
}

type MockSkiAreaPropertyOptions = {
  id?: string;
  name?: string;
  activities?: SkiAreaActivity[];
  status?: Status;
  sources?: Source[];
  statistics?: SkiAreaStatistics;
  websites?: string[];
  wikidataID?: string | null;
};

type MockSkiAreaGeometryOptions<G extends SkiAreaGeometry> = {
  geometry: G;
};

export function mockSkiAreaFeature<G extends SkiAreaGeometry>(
  options: MockSkiAreaPropertyOptions & MockSkiAreaGeometryOptions<G>,
): GeoJSON.Feature<G, SkiAreaProperties> {
  return {
    type: "Feature",
    properties: {
      type: FeatureType.SkiArea,
      id: options.id !== undefined ? options.id : "ID",
      name: options.name !== undefined ? options.name : "Name",
      activities:
        options.activities !== undefined
          ? options.activities
          : [SkiAreaActivity.Downhill],
      status: options.status !== undefined ? options.status : Status.Operating,
      sources:
        options.sources !== undefined
          ? options.sources
          : [{ id: "1", type: SourceType.SKIMAP_ORG }],
      runConvention: RunDifficultyConvention.EUROPE,
      statistics: options.statistics,
      websites: options.websites || [],
      wikidataID: options.wikidataID || null,
      places: [],
    },
    geometry: options.geometry,
  };
}

export function mockSkiAreaSiteFeature(
  options: MockSkiAreaPropertyOptions & { osmID: number },
) {
  return mockSkiAreaFeature({
    geometry: placeholderSiteGeometry(options.osmID),
    ...options,
  });
}

export function simplifiedLiftFeature(feature: LiftFeature) {
  return {
    id: feature.properties.id,
    name: feature.properties.name,
    skiAreas: feature.properties.skiAreas.map(
      (skiArea) => skiArea.properties.id,
    ),
  };
}

export function simplifiedRunFeature(feature: RunFeature) {
  return {
    id: feature.properties.id,
    name: feature.properties.name,
    skiAreas: feature.properties.skiAreas.map(
      (skiArea) => skiArea.properties.id,
    ),
  };
}

export function simplifiedSkiAreaFeature(feature: SkiAreaFeature) {
  return {
    id: feature.properties.id,
    name: feature.properties.name,
    activities: feature.properties.activities,
  };
}

export function simplifiedSkiAreaFeatureWithStatistics(
  feature: SkiAreaFeature,
) {
  return {
    ...simplifiedSkiAreaFeature(feature),
    statistics: feature.properties.statistics,
  };
}

export function simplifiedSkiAreaFeatureWithSources(feature: SkiAreaFeature) {
  return {
    ...simplifiedSkiAreaFeature(feature),
    sources: feature.properties.sources,
  };
}
