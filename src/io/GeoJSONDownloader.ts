import bboxPolygon from "@turf/bbox-polygon";
import booleanContains from "@turf/boolean-contains";
import { Readable } from "node:stream";
import * as JSONStream from "JSONStream";
import { Config, configFromEnvironment } from "../Config";
import { performanceMonitor } from "../clustering/database/PerformanceMonitor";
import { InputSkiMapOrgSkiAreaFeature } from "../features/SkiAreaFeature";
import { Logger } from "../utils/Logger";
import {
  OSMDownloadConfig,
  highwaysDownloadConfig,
  liftsDownloadConfig,
  runsDownloadConfig,
  skiAreaSitesDownloadConfig,
  skiAreasDownloadConfig,
  skiMapSkiAreasURL,
} from "./DownloadURLs";
import { fetchHighwaysFromLocalDB } from "./LocalHighwayProvider";
import { fetchLiftsFromLocalDB } from "./LocalLiftProvider";
import { fetchPeaksFromLocalDB } from "./LocalPeakProvider";
import { fetchRunsFromLocalDB } from "./LocalRunProvider";
import {
  fetchSkiAreasFromLocalDB,
  fetchSkiAreaSitesFromLocalDB,
} from "./LocalSkiAreaProvider";
import { convertOSMToGeoJSON } from "./OSMToGeoJSONConverter";
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
): Promise<void> {
  await performanceMonitor.withPhase("Phase 1: Download", async () => {
    const config = configFromEnvironment();
    const dataStore = getPostGISDataStore(config.postgresCache);

    await performanceMonitor.withOperation("Downloading OSM data", async () => {
      if (config.localOSMDatabase) {
        // Local OSM planet DB — all core ski data + skimap.org
        await Promise.all([
          downloadAndStoreRunsFromLocalDB(config, dataStore),
          downloadAndStoreLiftsFromLocalDB(config, dataStore),
          downloadAndStoreSkiAreasFromLocalDB(config, dataStore),
          downloadAndStoreSkiAreaSitesFromLocalDB(config, dataStore),
          downloadAndStoreSkiMapOrgSkiAreas(bbox, dataStore),
        ]);
      } else {
        // Overpass API fallback
        const overpassEndpoints = getOverpassEndpoints();
        await Promise.all([
          downloadAndStoreRuns(overpassEndpoints, bbox, dataStore),
          (async () => {
            await downloadAndStoreLifts(overpassEndpoints, bbox, dataStore);
            await downloadAndStoreSkiAreas(overpassEndpoints, bbox, dataStore);
            await downloadAndStoreSkiAreaSites(
              overpassEndpoints,
              bbox,
              dataStore,
            );
          })(),
          downloadAndStoreSkiMapOrgSkiAreas(bbox, dataStore),
        ]);
      }

      // Highway download runs after other downloads so ski features are in PostGIS
      // (needed for local DB buffer query, and serializing also avoids Overpass rate limits)
      if (process.env.COMPILE_HIGHWAY === "1") {
        if (config.localOSMDatabase) {
          await downloadAndStoreHighwaysFromLocalDB(config, dataStore);
        } else {
          const overpassEndpoints = getOverpassEndpoints();
          await downloadAndStoreHighways(overpassEndpoints, bbox, dataStore);
        }
      }

      // Peak download from local OSM database (peaks are always loaded when local DB is configured)
      if (config.localOSMDatabase) {
        await downloadAndStorePeaksFromLocalDB(config, dataStore);
      }
    });

    // Log counts
    const runsCount = await dataStore.getInputRunsCount();
    const liftsCount = await dataStore.getInputLiftsCount();
    const skiAreasCount = await dataStore.getInputSkiAreasCount();
    let countLog = `Stored in PostGIS: ${runsCount} runs, ${liftsCount} lifts, ${skiAreasCount} ski areas`;

    if (process.env.COMPILE_HIGHWAY === "1") {
      const highwaysCount = await dataStore.getInputHighwaysCount();
      countLog += `, ${highwaysCount} highways`;
    }
    if (config.localOSMDatabase) {
      const peaksCount = await dataStore.getInputPeaksCount();
      countLog += `, ${peaksCount} peaks`;
    }
    Logger.log(countLog);

    performanceMonitor.logTimeline();
  });
}

async function downloadAndStoreRuns(
  endpoints: string[],
  bbox: GeoJSON.BBox | null,
  dataStore: PostGISDataStore,
): Promise<void> {
  const osmJSON = await downloadOSMJSON(endpoints, runsDownloadConfig, bbox);
  const geoJSON = convertOSMToGeoJSON(osmJSON);

  const features = geoJSON.features.map((f: GeoJSON.Feature) =>
    osmFeatureToInputFeature(f),
  );
  await dataStore.saveInputRuns(features);
}

async function downloadAndStoreLifts(
  endpoints: string[],
  bbox: GeoJSON.BBox | null,
  dataStore: PostGISDataStore,
): Promise<void> {
  const osmJSON = await downloadOSMJSON(endpoints, liftsDownloadConfig, bbox);
  const geoJSON = convertOSMToGeoJSON(osmJSON);

  const features = geoJSON.features.map((f: GeoJSON.Feature) =>
    osmFeatureToInputFeature(f),
  );
  await dataStore.saveInputLifts(features);
}

async function downloadAndStoreSkiAreas(
  endpoints: string[],
  bbox: GeoJSON.BBox | null,
  dataStore: PostGISDataStore,
): Promise<void> {
  const osmJSON = await downloadOSMJSON(
    endpoints,
    skiAreasDownloadConfig,
    bbox,
  );
  const geoJSON = convertOSMToGeoJSON(osmJSON);

  const features = geoJSON.features.map((f: GeoJSON.Feature) => ({
    ...osmFeatureToInputFeature(f),
    source: "openstreetmap" as const,
  }));
  await dataStore.saveInputSkiAreas(features);
}

async function downloadAndStoreSkiAreaSites(
  endpoints: string[],
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
        const members = (element.members || [])
          .filter(
            (m: { type: string; ref: number }) =>
              m.type === "way" || m.type === "node",
          )
          .map((m: { type: string; ref: number }) => ({
            type: m.type,
            ref: m.ref,
          }));

        sites.push({
          osm_id: element.id,
          properties: element.tags || {},
          members,
        });
      }
    }
  }

  await dataStore.saveInputSkiAreaSites(sites);
}

async function downloadAndStoreSkiMapOrgSkiAreas(
  bbox: GeoJSON.BBox | null,
  dataStore: PostGISDataStore,
): Promise<void> {
  const geoJSON = await downloadSkiMapOrgGeoJSON(bbox);

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
}

async function downloadAndStoreHighways(
  endpoints: string[],
  bbox: GeoJSON.BBox | null,
  dataStore: PostGISDataStore,
): Promise<void> {
  const osmJSON = await downloadOSMJSON(
    endpoints,
    highwaysDownloadConfig,
    bbox,
  );
  const geoJSON = convertOSMToGeoJSON(osmJSON);

  const features = geoJSON.features.map((f: GeoJSON.Feature) =>
    osmFeatureToInputFeature(f),
  );
  await dataStore.saveInputHighways(features);
}

async function downloadAndStoreHighwaysFromLocalDB(
  config: Config,
  dataStore: PostGISDataStore,
): Promise<void> {
  Logger.log("Fetching highways from local OSM planet database...");
  await fetchHighwaysFromLocalDB(
    config.postgresCache,
    config.localOSMDatabase!,
    dataStore,
    config.localOSMDatabase!.bufferMeters,
  );
}

async function downloadAndStorePeaksFromLocalDB(
  config: Config,
  dataStore: PostGISDataStore,
): Promise<void> {
  Logger.log("Fetching peaks from local OSM planet database...");
  await fetchPeaksFromLocalDB(
    config.postgresCache,
    config.localOSMDatabase!,
    dataStore,
    config.localOSMDatabase!.bufferMeters,
  );
}

async function downloadAndStoreRunsFromLocalDB(
  config: Config,
  dataStore: PostGISDataStore,
): Promise<void> {
  Logger.log("Fetching runs from local OSM planet database...");
  await fetchRunsFromLocalDB(config.localOSMDatabase!, dataStore, config.bbox);
}

async function downloadAndStoreLiftsFromLocalDB(
  config: Config,
  dataStore: PostGISDataStore,
): Promise<void> {
  Logger.log("Fetching lifts from local OSM planet database...");
  await fetchLiftsFromLocalDB(config.localOSMDatabase!, dataStore, config.bbox);
}

async function downloadAndStoreSkiAreasFromLocalDB(
  config: Config,
  dataStore: PostGISDataStore,
): Promise<void> {
  Logger.log("Fetching ski areas from local OSM planet database...");
  await fetchSkiAreasFromLocalDB(
    config.localOSMDatabase!,
    dataStore,
    config.bbox,
  );
}

async function downloadAndStoreSkiAreaSitesFromLocalDB(
  config: Config,
  dataStore: PostGISDataStore,
): Promise<void> {
  Logger.log("Fetching ski area sites from local OSM planet database...");
  await fetchSkiAreaSitesFromLocalDB(config.localOSMDatabase!, dataStore);
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
  Logger.log("Performing overpass query...");
  Logger.log(query);
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
        Logger.log(
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

  if (!response.body) {
    throw new Error(`Response body is null for URL: ${sourceURL}`);
  }

  // Stream the response through JSONStream to avoid V8 string length limits
  // for very large responses (>512MB)
  return await new Promise((resolve, reject) => {
    const nodeStream = Readable.fromWeb(response.body as any);

    nodeStream.on("error", function (error: Error) {
      reject(error);
    });

    nodeStream
      .pipe(JSONStream.parse(null))
      .on("root", function (data: any) {
        // Iron out some nasty floating point rounding errors (copied from OSMToGeoJSONConverter)
        if (data.version) data.version = Math.round(data.version * 1000) / 1000;
        if (data.elements) {
          data.elements.forEach(function (element: any) {
            if (element.lat)
              element.lat = Math.round(element.lat * 1e12) / 1e12;
            if (element.lon)
              element.lon = Math.round(element.lon * 1e12) / 1e12;
          });
        }
        resolve(data);
      })
      .on("error", function (error: Error) {
        reject(error);
      });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function overpassURLForQuery(endpoint: string, query: string) {
  return endpoint + "?data=" + encodeURIComponent(query);
}
