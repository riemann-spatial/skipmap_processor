import bboxPolygon from "@turf/bbox-polygon";
import booleanContains from "@turf/boolean-contains";
import { readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { configFromEnvironment, PostgresConfig } from "../Config";
import { performanceMonitor } from "../clustering/database/PerformanceMonitor";
import { InputSkiMapOrgSkiAreaFeature } from "../features/SkiAreaFeature";
import {
  OSMDownloadConfig,
  liftsDownloadConfig,
  runsDownloadConfig,
  skiAreaSitesDownloadConfig,
  skiAreasDownloadConfig,
  skiMapSkiAreasURL,
} from "./DownloadURLs";
import { InputDataPaths } from "./GeoJSONFiles";
import convertOSMFileToGeoJSON, {
  convertOSMToGeoJSON,
} from "./OSMToGeoJSONConverter";
import {
  getPostGISDataStore,
  InputFeature,
  InputSkiAreaFeature,
  InputSkiAreaSite,
  PostGISDataStore,
} from "./PostGISDataStore";

export default async function downloadAndConvertToGeoJSON(
  folder: string,
  bbox: GeoJSON.BBox | null,
): Promise<InputDataPaths> {
  return await performanceMonitor.withPhase("Phase 1: Download", async () => {
    const paths = new InputDataPaths(folder);
    const config = configFromEnvironment();
    const dataStore = getPostGISDataStore(config.postgresCache);

    const overpassEndpoints = getOverpassEndpoints();

    // Serialize downloads using the same endpoint so we don't get rate limited by the Overpass API
    await performanceMonitor.withOperation("Downloading OSM data", async () => {
      await Promise.all([
        downloadAndStoreRuns(overpassEndpoints, paths, bbox, dataStore),
        (async () => {
          await downloadAndStoreLifts(
            overpassEndpoints,
            paths,
            bbox,
            dataStore,
          );
          await downloadAndStoreSkiAreas(
            overpassEndpoints,
            paths,
            bbox,
            dataStore,
          );
          await downloadAndStoreSkiAreaSites(
            overpassEndpoints,
            paths,
            bbox,
            dataStore,
          );
        })(),
        downloadAndStoreSkiMapOrgSkiAreas(paths, bbox, dataStore),
      ]);
    });

    // Log counts
    const runsCount = await dataStore.getInputRunsCount();
    const liftsCount = await dataStore.getInputLiftsCount();
    const skiAreasCount = await dataStore.getInputSkiAreasCount();
    console.log(
      `Stored in PostGIS: ${runsCount} runs, ${liftsCount} lifts, ${skiAreasCount} ski areas`,
    );

    performanceMonitor.logTimeline();

    return paths;
  });
}

async function downloadAndStoreRuns(
  endpoints: string[],
  paths: InputDataPaths,
  bbox: GeoJSON.BBox | null,
  dataStore: PostGISDataStore,
): Promise<void> {
  const osmJSON = await downloadOSMJSON(endpoints, runsDownloadConfig, bbox);
  const geoJSON = convertOSMToGeoJSON(osmJSON);

  // Store in PostGIS
  const features = geoJSON.features.map((f: GeoJSON.Feature) =>
    osmFeatureToInputFeature(f),
  );
  await dataStore.saveInputRuns(features);

  // Also write to file for backward compatibility
  await writeFeatureCollection(geoJSON, paths.geoJSON.runs);
}

async function downloadAndStoreLifts(
  endpoints: string[],
  paths: InputDataPaths,
  bbox: GeoJSON.BBox | null,
  dataStore: PostGISDataStore,
): Promise<void> {
  const osmJSON = await downloadOSMJSON(endpoints, liftsDownloadConfig, bbox);
  const geoJSON = convertOSMToGeoJSON(osmJSON);

  // Store in PostGIS
  const features = geoJSON.features.map((f: GeoJSON.Feature) =>
    osmFeatureToInputFeature(f),
  );
  await dataStore.saveInputLifts(features);

  // Also write to file for backward compatibility
  await writeFeatureCollection(geoJSON, paths.geoJSON.lifts);
}

async function downloadAndStoreSkiAreas(
  endpoints: string[],
  paths: InputDataPaths,
  bbox: GeoJSON.BBox | null,
  dataStore: PostGISDataStore,
): Promise<void> {
  const osmJSON = await downloadOSMJSON(
    endpoints,
    skiAreasDownloadConfig,
    bbox,
  );
  const geoJSON = convertOSMToGeoJSON(osmJSON);

  // Store in PostGIS
  const features = geoJSON.features.map((f: GeoJSON.Feature) => ({
    ...osmFeatureToInputFeature(f),
    source: "openstreetmap" as const,
  }));
  await dataStore.saveInputSkiAreas(features);

  // Also write to file for backward compatibility
  await writeFeatureCollection(geoJSON, paths.geoJSON.skiAreas);
}

async function downloadAndStoreSkiAreaSites(
  endpoints: string[],
  paths: InputDataPaths,
  bbox: GeoJSON.BBox | null,
  dataStore: PostGISDataStore,
): Promise<void> {
  const osmJSON = await downloadOSMJSON(
    endpoints,
    skiAreaSitesDownloadConfig,
    bbox,
  );

  // Parse ski area sites from OSM JSON (relations)
  const sites: InputSkiAreaSite[] = [];
  if (osmJSON.elements) {
    for (const element of osmJSON.elements) {
      if (element.type === "relation") {
        const memberIds = (element.members || [])
          .filter(
            (m: { type: string; ref: number }) =>
              m.type === "way" || m.type === "node",
          )
          .map((m: { ref: number }) => m.ref);

        sites.push({
          osm_id: element.id,
          properties: element.tags || {},
          member_ids: memberIds,
        });
      }
    }
  }

  await dataStore.saveInputSkiAreaSites(sites);

  // Write the raw OSM JSON to file for backward compatibility
  await writeFile(paths.osmJSON.skiAreaSites, JSON.stringify(osmJSON));
}

async function downloadAndStoreSkiMapOrgSkiAreas(
  paths: InputDataPaths,
  bbox: GeoJSON.BBox | null,
  dataStore: PostGISDataStore,
): Promise<void> {
  const geoJSON = await downloadSkiMapOrgGeoJSON(bbox);

  // Store in PostGIS
  const features: InputSkiAreaFeature[] = geoJSON.features.map(
    (f: GeoJSON.Feature) => ({
      osm_id: typeof f.id === "number" ? f.id : parseInt(String(f.id), 10) || 0,
      osm_type: "skimap",
      geometry: f.geometry,
      properties: f.properties || {},
      source: "skimap" as const,
    }),
  );
  await dataStore.saveInputSkiAreas(features);

  // Also write to file for backward compatibility
  await writeFile(paths.geoJSON.skiMapSkiAreas, JSON.stringify(geoJSON));
}

function osmFeatureToInputFeature(feature: GeoJSON.Feature): InputFeature {
  const props = feature.properties || {};
  return {
    osm_id: props.id || 0,
    osm_type: props.type || "unknown",
    geometry: feature.geometry,
    properties: props,
  };
}

const DEFAULT_OVERPASS_ENDPOINTS = [
  // Multiple public Overpass instances to reduce flakiness (e.g. 504s under load)
  "https://z.overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function getOverpassEndpoints(): string[] {
  const env = process.env.OVERPASS_ENDPOINTS?.trim();
  if (!env) {
    return DEFAULT_OVERPASS_ENDPOINTS;
  }

  const endpoints = env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return endpoints.length > 0 ? endpoints : DEFAULT_OVERPASS_ENDPOINTS;
}

async function downloadOSMJSON(
  endpoints: string[],
  config: OSMDownloadConfig,
  bbox: GeoJSON.BBox | null,
): Promise<any> {
  const query = config.query(bbox);
  console.log("Performing overpass query...");
  console.log(query);
  const urls = endpoints.map((endpoint) =>
    overpassURLForQuery(endpoint, query),
  );
  return await downloadJSONWithFallback(urls);
}

async function downloadSkiMapOrgGeoJSON(
  bbox: GeoJSON.BBox | null,
): Promise<GeoJSON.FeatureCollection> {
  const response = await fetch(skiMapSkiAreasURL, {
    headers: { Referer: "https://openskimap.org" },
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed downloading file at URL (status: ${response.status}): ${skiMapSkiAreasURL}`,
    );
  }

  const json: GeoJSON.FeatureCollection = await response.json();

  if (!bbox) {
    return json;
  }

  // For consistency with the OSM data (which has the bounding box applied on Overpass API), apply bbox filtering on the downloaded GeoJSON.
  const bboxGeometry = bboxPolygon(bbox);
  json.features = (json.features as InputSkiMapOrgSkiAreaFeature[]).filter(
    (feature) => booleanContains(bboxGeometry, feature),
  );

  return json;
}

async function downloadJSONWithFallback(
  sourceURLs: string[],
  retries: number = 10,
): Promise<any> {
  let lastError: unknown = null;

  // Try all endpoints before sleeping; repeat for a bounded number of retries.
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const sourceURL of sourceURLs) {
      try {
        return await _downloadJSON(sourceURL);
      } catch (e) {
        lastError = e;
        console.log(
          "Download failed due to " +
            e +
            ". Will try another Overpass endpoint (or retry after a minute).",
        );
      }
    }

    if (attempt >= retries) {
      throw lastError;
    }

    await sleep(60000);
  }

  // Unreachable, but keeps TS happy.
  throw lastError;
}

async function _downloadJSON(sourceURL: string): Promise<any> {
  const response = await fetch(sourceURL, {
    headers: { Referer: "https://openskimap.org" },
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed downloading file at URL (status: ${response.status}): ${sourceURL}`,
    );
  }

  const text = await response.text();
  const data = JSON.parse(text);

  // Iron out some nasty floating point rounding errors (copied from OSMToGeoJSONConverter)
  if (data.version) data.version = Math.round(data.version * 1000) / 1000;
  if (data.elements) {
    data.elements.forEach(function (element: any) {
      if (element.lat) element.lat = Math.round(element.lat * 1e12) / 1e12;
      if (element.lon) element.lon = Math.round(element.lon * 1e12) / 1e12;
    });
  }

  return data;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function overpassURLForQuery(endpoint: string, query: string) {
  return endpoint + "?data=" + encodeURIComponent(query);
}

function writeFeatureCollection(geojson: any, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fs = require("fs");
    const outputStream = fs.createWriteStream(path);
    const separator = "\n";

    outputStream.write(
      "{" +
        separator +
        '"type": "FeatureCollection",' +
        separator +
        '"features": [' +
        separator,
    );
    geojson.features.forEach(function (f: any, i: any) {
      outputStream.write(JSON.stringify(f, null, 0));
      if (i != geojson.features.length - 1) {
        outputStream.write("," + separator);
      }
    });
    outputStream.write(separator + "]" + separator + "}" + separator);
    outputStream.on("finish", resolve);
    outputStream.on("error", reject);
    outputStream.end();
  });
}
