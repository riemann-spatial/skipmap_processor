import { SourceType } from "openskidata-format";
import { Logger } from "../../utils/Logger";
import {
  ClusteringDatabase,
  SearchContext,
} from "../database/ClusteringDatabase";
import { SkiAreaObject } from "../MapObject";
import mergeSkiAreaObjects from "../MergeSkiAreaObjects";
import { allSkiAreaActivities } from "../SkiAreaClusteringService";

export class SkiAreaMerging {
  constructor(private database: ClusteringDatabase) {}

  async mergeSkimapOrgWithOpenStreetMapSkiAreas(): Promise<void> {
    const skiAreasCursor = await this.database.getSkiAreas({
      onlySource: SourceType.SKIMAP_ORG,
      useBatching: false,
    });

    const processedSkimapOrgIds = new Set<string>();
    const skiAreas = await skiAreasCursor.all();

    for (const skiArea of skiAreas) {
      if (processedSkimapOrgIds.has(skiArea.id)) {
        continue;
      }

      const hasKnownSkiAreaActivities = skiArea.activities.length > 0;
      const activitiesForClustering = hasKnownSkiAreaActivities
        ? skiArea.activities
        : Array.from(allSkiAreaActivities);

      const skiAreasToMerge = await this.getSkiAreasToMergeInto({
        ...skiArea,
        activities: activitiesForClustering,
      });

      if (skiAreasToMerge.length > 0) {
        const allRelatedSkimapOrgIds = await this.findAllRelatedSkimapOrgIds(
          skiArea,
          skiAreasToMerge,
        );

        allRelatedSkimapOrgIds.forEach((id) => processedSkimapOrgIds.add(id));

        await this.mergeIntoSkiAreas(skiArea, skiAreasToMerge);
      }
    }
  }

  private async getSkiAreasToMergeInto(
    skiArea: SkiAreaObject,
  ): Promise<SkiAreaObject[]> {
    const maxMergeDistanceInKilometers = 0.25;

    const context: SearchContext = {
      id: skiArea.id,
      activities: skiArea.activities,
      alreadyVisited: [],
      searchType: "intersects",
      isFixedSearchArea: true,
    };

    const bufferedContext: SearchContext = {
      ...context,
      bufferDistanceKm: maxMergeDistanceInKilometers,
    };
    const nearbyObjects = await this.database.findNearbyObjects(
      skiArea.geometry,
      bufferedContext,
    );
    const otherSkiAreaIDs = new Set(
      nearbyObjects.flatMap((object) =>
        object.skiAreas.map((assignment) => assignment.skiAreaId),
      ),
    );

    const otherSkiAreasCursor = await this.database.getSkiAreasByIds(
      Array.from(otherSkiAreaIDs),
      true,
    );
    const otherSkiAreas: SkiAreaObject[] = await otherSkiAreasCursor.all();

    return otherSkiAreas.filter(
      (otherSkiArea) => otherSkiArea.source !== skiArea.source,
    );
  }

  private async findAllRelatedSkimapOrgIds(
    currentSkimapOrgSkiArea: SkiAreaObject,
    targetSkiAreas: SkiAreaObject[],
  ): Promise<string[]> {
    const relatedIds = new Set<string>([currentSkimapOrgSkiArea.id]);

    for (const targetSkiArea of targetSkiAreas) {
      const skimapOrgSources = targetSkiArea.properties.sources.filter(
        (source) => source.type === SourceType.SKIMAP_ORG,
      );

      for (const source of skimapOrgSources) {
        relatedIds.add(source.id.toString());
      }
    }

    return Array.from(relatedIds);
  }

  private async mergeIntoSkiAreas(
    skimapOrgSkiArea: SkiAreaObject,
    skiAreas: SkiAreaObject[],
  ): Promise<void> {
    Logger.log(
      `Merging ${JSON.stringify(skimapOrgSkiArea.properties)} into: ${skiAreas
        .map((object) => JSON.stringify(object.properties))
        .join(", ")}`,
    );

    const updates = skiAreas.map((skiArea) => ({
      key: skiArea._key,
      updates: mergeSkiAreaObjects(skiArea, [skimapOrgSkiArea]),
    }));

    await Promise.all([
      this.database.updateObjects(updates),
      this.database.removeObject(skimapOrgSkiArea._key),
    ]);
  }
}
