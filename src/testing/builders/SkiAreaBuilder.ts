import {
  FeatureType,
  Place,
  RunDifficultyConvention,
  SkiAreaActivity,
  SkiAreaFeature,
  SkiAreaProperties,
  SkiAreaStatistics,
  Source,
  SourceType,
  Status,
} from "openskidata-format";
import { v4 as uuid } from "uuid";
import {
  DraftSkiArea,
  MapObjectType,
  SkiAreaGeometry,
  SkiAreaObject,
} from "../../clustering/MapObject";

/**
 * Builder for creating SkiAreaFeature test objects with fluent API
 */
export class SkiAreaBuilder {
  private id: string;
  private name: string | null = "Test Ski Area";
  private activities: SkiAreaActivity[] = [SkiAreaActivity.Downhill];
  private status: Status = Status.Operating;
  private sources: Source[] = [];
  private geometry: SkiAreaGeometry = { type: "Point", coordinates: [0, 0] };
  private runConvention: RunDifficultyConvention =
    RunDifficultyConvention.EUROPE;
  private statistics?: SkiAreaStatistics;
  private websites: string[] = [];
  private wikidataID: string | null = null;
  private places: Place[] = [];

  constructor(id?: string) {
    this.id = id || uuid();
    this.sources = [{ id: this.id, type: SourceType.OPENSTREETMAP }];
  }

  static create(id?: string): SkiAreaBuilder {
    return new SkiAreaBuilder(id);
  }

  withName(name: string | null): SkiAreaBuilder {
    this.name = name;
    return this;
  }

  withActivities(...activities: SkiAreaActivity[]): SkiAreaBuilder {
    this.activities = activities;
    return this;
  }

  asDownhill(): SkiAreaBuilder {
    this.activities = [SkiAreaActivity.Downhill];
    return this;
  }

  asNordic(): SkiAreaBuilder {
    this.activities = [SkiAreaActivity.Nordic];
    return this;
  }

  asMixed(): SkiAreaBuilder {
    this.activities = [SkiAreaActivity.Downhill, SkiAreaActivity.Nordic];
    return this;
  }

  withStatus(status: Status): SkiAreaBuilder {
    this.status = status;
    return this;
  }

  asOperating(): SkiAreaBuilder {
    this.status = Status.Operating;
    return this;
  }

  asClosed(): SkiAreaBuilder {
    this.status = Status.Abandoned;
    return this;
  }

  withSources(...sources: Source[]): SkiAreaBuilder {
    this.sources = sources;
    return this;
  }

  fromOpenStreetMap(osmId?: string): SkiAreaBuilder {
    this.sources = [{ id: osmId || this.id, type: SourceType.OPENSTREETMAP }];
    return this;
  }

  fromSkiMapOrg(skimapId?: string): SkiAreaBuilder {
    this.sources = [{ id: skimapId || this.id, type: SourceType.SKIMAP_ORG }];
    return this;
  }

  atPoint(lon: number, lat: number): SkiAreaBuilder {
    this.geometry = { type: "Point", coordinates: [lon, lat] };
    return this;
  }

  withPolygon(coordinates: GeoJSON.Position[][]): SkiAreaBuilder {
    this.geometry = { type: "Polygon", coordinates };
    return this;
  }

  withGeometry(geometry: SkiAreaGeometry): SkiAreaBuilder {
    this.geometry = geometry;
    return this;
  }

  withStatistics(statistics: SkiAreaStatistics): SkiAreaBuilder {
    this.statistics = statistics;
    return this;
  }

  withWebsites(...websites: string[]): SkiAreaBuilder {
    this.websites = websites;
    return this;
  }

  withWikidataID(wikidataID: string): SkiAreaBuilder {
    this.wikidataID = wikidataID;
    return this;
  }

  withPlaces(...places: Place[]): SkiAreaBuilder {
    this.places = places;
    return this;
  }

  withRunConvention(convention: RunDifficultyConvention): SkiAreaBuilder {
    this.runConvention = convention;
    return this;
  }

  /**
   * Build a SkiAreaFeature (GeoJSON format)
   */
  build(): SkiAreaFeature {
    const properties: SkiAreaProperties = {
      type: FeatureType.SkiArea,
      id: this.id,
      name: this.name,
      activities: this.activities,
      status: this.status,
      sources: this.sources,
      runConvention: this.runConvention,
      statistics: this.statistics,
      websites: this.websites,
      wikidataID: this.wikidataID,
      places: this.places,
    };

    return {
      type: "Feature",
      properties,
      geometry: this.geometry,
    };
  }

  /**
   * Build a DraftSkiArea (for clustering database operations)
   */
  buildDraft(): DraftSkiArea {
    return {
      _key: this.id,
      id: this.id,
      type: MapObjectType.SkiArea,
      skiAreas: [],
      activities: this.activities,
      geometry: this.geometry,
      isPolygon:
        this.geometry.type === "Polygon" ||
        this.geometry.type === "MultiPolygon",
      source: this.sources[0]?.type || SourceType.OPENSTREETMAP,
      properties: this.build().properties,
    };
  }

  /**
   * Build a SkiAreaObject (for database operations)
   */
  buildObject(): SkiAreaObject {
    return {
      _key: this.id,
      _id: this.id,
      id: this.id,
      type: MapObjectType.SkiArea,
      skiAreas: [],
      activities: this.activities,
      geometry: this.geometry,
      isPolygon:
        this.geometry.type === "Polygon" ||
        this.geometry.type === "MultiPolygon",
      source: this.sources[0]?.type || SourceType.OPENSTREETMAP,
      properties: this.build().properties,
    };
  }
}
