import {
  FeatureType,
  Place,
  RunDifficulty,
  RunDifficultyConvention,
  RunFeature,
  RunGeometry,
  RunGrooming,
  RunProperties,
  RunUse,
  SkiAreaActivity,
  SkiAreaFeature,
  Source,
  SourceType,
  Status,
} from "openskidata-format";
import { v4 as uuid } from "uuid";
import { DraftRun, MapObjectType, RunObject } from "../../clustering/MapObject";

/**
 * Builder for creating RunFeature test objects with fluent API
 */
export class RunBuilder {
  private id: string;
  private _name: string | null = "Test Run";
  private _uses: RunUse[] = [RunUse.Downhill];
  private _difficulty: RunDifficulty | null = null;
  private _difficultyConvention: RunDifficultyConvention =
    RunDifficultyConvention.EUROPE;
  private _ref: string | null = null;
  private _oneway: boolean | null = null;
  private _lit: boolean | null = null;
  private _description: string | null = null;
  private _gladed: boolean | null = null;
  private _patrolled: boolean | null = null;
  private _grooming: RunGrooming | null = null;
  private _skiAreas: SkiAreaFeature[] = [];
  private _status: Status = Status.Operating;
  private _sources: Source[] = [];
  private _websites: string[] = [];
  private _wikidataID: string | null = null;
  private _places: Place[] = [];
  private _geometry: RunGeometry = {
    type: "LineString",
    coordinates: [
      [0, 0],
      [0.01, 0.01],
    ],
  };

  constructor(id?: string) {
    this.id = id || uuid();
    this._sources = [{ id: this.id, type: SourceType.OPENSTREETMAP }];
  }

  static create(id?: string): RunBuilder {
    return new RunBuilder(id);
  }

  withName(name: string | null): RunBuilder {
    this._name = name;
    return this;
  }

  withUses(...uses: RunUse[]): RunBuilder {
    this._uses = uses;
    return this;
  }

  asDownhill(): RunBuilder {
    this._uses = [RunUse.Downhill];
    return this;
  }

  asNordic(): RunBuilder {
    this._uses = [RunUse.Nordic];
    return this;
  }

  asSnowPark(): RunBuilder {
    this._uses = [RunUse.SnowPark];
    return this;
  }

  asSkitour(): RunBuilder {
    this._uses = [RunUse.Skitour];
    return this;
  }

  withDifficulty(difficulty: RunDifficulty): RunBuilder {
    this._difficulty = difficulty;
    return this;
  }

  easy(): RunBuilder {
    this._difficulty = RunDifficulty.EASY;
    return this;
  }

  intermediate(): RunBuilder {
    this._difficulty = RunDifficulty.INTERMEDIATE;
    return this;
  }

  advanced(): RunBuilder {
    this._difficulty = RunDifficulty.ADVANCED;
    return this;
  }

  expert(): RunBuilder {
    this._difficulty = RunDifficulty.EXPERT;
    return this;
  }

  withDifficultyConvention(convention: RunDifficultyConvention): RunBuilder {
    this._difficultyConvention = convention;
    return this;
  }

  withRef(ref: string): RunBuilder {
    this._ref = ref;
    return this;
  }

  asOneway(): RunBuilder {
    this._oneway = true;
    return this;
  }

  withGrooming(grooming: RunGrooming): RunBuilder {
    this._grooming = grooming;
    return this;
  }

  groomed(): RunBuilder {
    this._grooming = RunGrooming.Classic;
    return this;
  }

  backcountry(): RunBuilder {
    this._grooming = RunGrooming.Backcountry;
    return this;
  }

  asPatrolled(): RunBuilder {
    this._patrolled = true;
    return this;
  }

  asLit(): RunBuilder {
    this._lit = true;
    return this;
  }

  asGladed(): RunBuilder {
    this._gladed = true;
    return this;
  }

  withStatus(status: Status): RunBuilder {
    this._status = status;
    return this;
  }

  asOperating(): RunBuilder {
    this._status = Status.Operating;
    return this;
  }

  asClosed(): RunBuilder {
    this._status = Status.Abandoned;
    return this;
  }

  withSources(...sources: Source[]): RunBuilder {
    this._sources = sources;
    return this;
  }

  inSkiArea(skiArea: SkiAreaFeature): RunBuilder {
    this._skiAreas.push(skiArea);
    return this;
  }

  inSkiAreas(...skiAreas: SkiAreaFeature[]): RunBuilder {
    this._skiAreas = skiAreas;
    return this;
  }

  withLine(coordinates: GeoJSON.Position[]): RunBuilder {
    this._geometry = { type: "LineString", coordinates };
    return this;
  }

  withPolygon(coordinates: GeoJSON.Position[][]): RunBuilder {
    this._geometry = { type: "Polygon", coordinates };
    return this;
  }

  withGeometry(geometry: RunGeometry): RunBuilder {
    this._geometry = geometry;
    return this;
  }

  fromPoint(lon: number, lat: number): RunBuilder {
    this._geometry = {
      type: "LineString",
      coordinates: [
        [lon, lat],
        [lon + 0.01, lat + 0.01],
      ],
    };
    return this;
  }

  withWebsites(...websites: string[]): RunBuilder {
    this._websites = websites;
    return this;
  }

  withWikidataID(wikidataID: string): RunBuilder {
    this._wikidataID = wikidataID;
    return this;
  }

  withPlaces(...places: Place[]): RunBuilder {
    this._places = places;
    return this;
  }

  /**
   * Build a RunFeature (GeoJSON format)
   */
  build(): RunFeature {
    const properties: RunProperties = {
      type: FeatureType.Run,
      id: this.id,
      name: this._name,
      uses: this._uses,
      difficulty: this._difficulty,
      difficultyConvention: this._difficultyConvention,
      ref: this._ref,
      oneway: this._oneway,
      lit: this._lit,
      description: this._description,
      gladed: this._gladed,
      patrolled: this._patrolled,
      grooming: this._grooming,
      skiAreas: this._skiAreas,
      elevationProfile: null,
      status: this._status,
      sources: this._sources,
      websites: this._websites,
      wikidataID: this._wikidataID,
      places: this._places,
    };

    return {
      type: "Feature",
      properties,
      geometry: this._geometry,
    };
  }

  /**
   * Build a DraftRun (for clustering database operations)
   */
  buildDraft(): DraftRun {
    const activities: SkiAreaActivity[] = this._uses.flatMap((use) => {
      if (use === RunUse.Downhill || use === RunUse.SnowPark) {
        return [SkiAreaActivity.Downhill];
      }
      if (use === RunUse.Nordic) {
        return [SkiAreaActivity.Nordic];
      }
      return [];
    });

    return {
      _key: this.id,
      type: MapObjectType.Run,
      geometry: this._geometry,
      geometryWithElevations: this._geometry,
      isBasisForNewSkiArea: this._skiAreas.length === 0,
      skiAreas: this._skiAreas.map((s) => ({
        skiAreaId: s.properties.id,
        assignedFrom: "site" as const,
      })),
      isInSkiAreaPolygon: false,
      isInSkiAreaSite: this._skiAreas.length > 0,
      activities,
      difficulty: this._difficulty,
      viirsPixels: [],
      properties: { places: this._places },
    };
  }

  /**
   * Build a RunObject (for database operations)
   */
  buildObject(): RunObject {
    const draft = this.buildDraft();
    return {
      ...draft,
      _id: this.id,
    };
  }
}
