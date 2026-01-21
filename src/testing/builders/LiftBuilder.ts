import {
  FeatureType,
  LiftFeature,
  LiftProperties,
  LiftType,
  Place,
  SkiAreaActivity,
  SkiAreaFeature,
  Source,
  SourceType,
  Status,
} from "openskidata-format";
import { v4 as uuid } from "uuid";
import {
  DraftLift,
  LiftObject,
  MapObjectType,
} from "../../clustering/MapObject";

type LiftGeometry = GeoJSON.LineString | GeoJSON.MultiLineString;

/**
 * Builder for creating LiftFeature test objects with fluent API
 */
export class LiftBuilder {
  private id: string;
  private name: string | null = "Test Lift";
  private liftType: LiftType = LiftType.ChairLift;
  private status: Status = Status.Operating;
  private ref: string | null = null;
  private refFRCAIRN: string | null = null;
  private description: string | null = null;
  private oneway: boolean | null = null;
  private occupancy: number | null = null;
  private capacity: number | null = null;
  private duration: number | null = null;
  private bubble: boolean | null = null;
  private heating: boolean | null = null;
  private detachable: boolean | null = null;
  private skiAreas: SkiAreaFeature[] = [];
  private sources: Source[] = [];
  private websites: string[] = [];
  private wikidataID: string | null = null;
  private places: Place[] = [];
  private geometry: LiftGeometry = {
    type: "LineString",
    coordinates: [
      [0, 0],
      [0.01, 0.01],
    ],
  };

  constructor(id?: string) {
    this.id = id || uuid();
    this.sources = [{ id: this.id, type: SourceType.OPENSTREETMAP }];
  }

  static create(id?: string): LiftBuilder {
    return new LiftBuilder(id);
  }

  withName(name: string | null): LiftBuilder {
    this.name = name;
    return this;
  }

  withLiftType(liftType: LiftType): LiftBuilder {
    this.liftType = liftType;
    return this;
  }

  asChairLift(): LiftBuilder {
    this.liftType = LiftType.ChairLift;
    return this;
  }

  asGondola(): LiftBuilder {
    this.liftType = LiftType.Gondola;
    return this;
  }

  asCableCar(): LiftBuilder {
    this.liftType = LiftType.CableCar;
    return this;
  }

  asDragLift(): LiftBuilder {
    this.liftType = LiftType.DragLift;
    return this;
  }

  asTBar(): LiftBuilder {
    this.liftType = LiftType.TBar;
    return this;
  }

  asMagicCarpet(): LiftBuilder {
    this.liftType = LiftType.MagicCarpet;
    return this;
  }

  asPlatter(): LiftBuilder {
    this.liftType = LiftType.Platter;
    return this;
  }

  asFunicular(): LiftBuilder {
    this.liftType = LiftType.Funicular;
    return this;
  }

  withStatus(status: Status): LiftBuilder {
    this.status = status;
    return this;
  }

  asOperating(): LiftBuilder {
    this.status = Status.Operating;
    return this;
  }

  asClosed(): LiftBuilder {
    this.status = Status.Abandoned;
    return this;
  }

  withRef(ref: string): LiftBuilder {
    this.ref = ref;
    return this;
  }

  withOccupancy(occupancy: number): LiftBuilder {
    this.occupancy = occupancy;
    return this;
  }

  withCapacity(capacity: number): LiftBuilder {
    this.capacity = capacity;
    return this;
  }

  withDuration(duration: number): LiftBuilder {
    this.duration = duration;
    return this;
  }

  withBubble(): LiftBuilder {
    this.bubble = true;
    return this;
  }

  withHeating(): LiftBuilder {
    this.heating = true;
    return this;
  }

  asDetachable(): LiftBuilder {
    this.detachable = true;
    return this;
  }

  withSources(...sources: Source[]): LiftBuilder {
    this.sources = sources;
    return this;
  }

  inSkiArea(skiArea: SkiAreaFeature): LiftBuilder {
    this.skiAreas.push(skiArea);
    return this;
  }

  inSkiAreas(...skiAreas: SkiAreaFeature[]): LiftBuilder {
    this.skiAreas = skiAreas;
    return this;
  }

  withLine(coordinates: GeoJSON.Position[]): LiftBuilder {
    this.geometry = { type: "LineString", coordinates };
    return this;
  }

  withMultiLine(coordinates: GeoJSON.Position[][]): LiftBuilder {
    this.geometry = { type: "MultiLineString", coordinates };
    return this;
  }

  withGeometry(geometry: LiftGeometry): LiftBuilder {
    this.geometry = geometry;
    return this;
  }

  fromPoint(lon: number, lat: number): LiftBuilder {
    this.geometry = {
      type: "LineString",
      coordinates: [
        [lon, lat],
        [lon + 0.01, lat + 0.01],
      ],
    };
    return this;
  }

  withWebsites(...websites: string[]): LiftBuilder {
    this.websites = websites;
    return this;
  }

  withWikidataID(wikidataID: string): LiftBuilder {
    this.wikidataID = wikidataID;
    return this;
  }

  withPlaces(...places: Place[]): LiftBuilder {
    this.places = places;
    return this;
  }

  /**
   * Build a LiftFeature (GeoJSON format)
   */
  build(): LiftFeature {
    const properties: LiftProperties = {
      type: FeatureType.Lift,
      id: this.id,
      name: this.name,
      liftType: this.liftType,
      status: this.status,
      ref: this.ref,
      refFRCAIRN: this.refFRCAIRN,
      description: this.description,
      oneway: this.oneway,
      occupancy: this.occupancy,
      capacity: this.capacity,
      duration: this.duration,
      bubble: this.bubble,
      heating: this.heating,
      detachable: this.detachable,
      skiAreas: this.skiAreas,
      sources: this.sources,
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
   * Build a DraftLift (for clustering database operations)
   */
  buildDraft(): DraftLift {
    const activities: SkiAreaActivity[] =
      this.status === Status.Operating ? [SkiAreaActivity.Downhill] : [];

    return {
      _key: this.id,
      type: MapObjectType.Lift,
      geometry: this.geometry,
      geometryWithElevations: this.geometry,
      activities: [...activities],
      skiAreas: this.skiAreas.map((s) => s.properties.id),
      isInSkiAreaPolygon: false,
      isInSkiAreaSite: this.skiAreas.length > 0,
      liftType: this.liftType,
      properties: { places: this.places },
    };
  }

  /**
   * Build a LiftObject (for database operations)
   */
  buildObject(): LiftObject {
    const draft = this.buildDraft();
    return {
      ...draft,
      _id: this.id,
    };
  }
}
