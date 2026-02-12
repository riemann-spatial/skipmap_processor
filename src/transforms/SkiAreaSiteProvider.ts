import {
  LiftFeature,
  RunFeature,
  SkiAreaFeature,
  SourceType,
} from "openskidata-format";
import { PostGISDataStore } from "../io/PostGISDataStore";
import { Logger } from "../utils/Logger";
import { formatSkiArea, InputSkiAreaType } from "./SkiAreaFormatter";

export class SkiAreaSiteProvider {
  private all: SkiAreaFeature[] = [];
  private geoJSONByOSMID = new Map<string, SkiAreaFeature[]>();
  private format = formatSkiArea(InputSkiAreaType.OPENSTREETMAP_SITE);

  async loadSitesFromDB(dataStore: PostGISDataStore): Promise<void> {
    for await (const site of dataStore.streamInputSkiAreaSites()) {
      const siteInput = {
        type: "relation" as const,
        id: site.osm_id,
        members: site.members.map((m) => ({
          type: m.type,
          ref: m.ref,
          role: "",
        })),
        tags: site.properties as Record<string, string>,
      };

      const skiArea = this.format(siteInput);
      if (skiArea) {
        this.all.push(skiArea);
        for (const member of site.members) {
          const id = member.type + "/" + member.ref.toString();
          const memberSkiAreas = this.geoJSONByOSMID.get(id) || [];
          memberSkiAreas.push(skiArea);
          this.geoJSONByOSMID.set(id, memberSkiAreas);
        }
      } else {
        Logger.log(
          "Failed converting site to ski area: " + JSON.stringify(site),
        );
      }
    }
  }

  getSitesForObject = (osmID: string) => {
    return this.geoJSONByOSMID.get(osmID) || [];
  };

  getGeoJSONSites = () => this.all;
}

export function addSkiAreaSites(siteProvider: SkiAreaSiteProvider) {
  return (feature: RunFeature | LiftFeature) => {
    const osmIDs = feature.properties.sources
      .filter((source) => source.type == SourceType.OPENSTREETMAP)
      .map((source) => source.id);
    feature.properties.skiAreas = osmIDs.flatMap((osmID) =>
      siteProvider.getSitesForObject(osmID),
    );
    return feature;
  };
}
