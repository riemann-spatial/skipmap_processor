import { SkiAreaActivity } from "openskidata-format";
import { SkiAreaBuilder } from "../builders";

/**
 * Pre-built ski area fixtures for common test scenarios
 */

export const fixtures = {
  /**
   * A simple downhill ski area at a known location (Whistler, BC)
   */
  whistler: () =>
    SkiAreaBuilder.create("whistler-test")
      .withName("Whistler Blackcomb")
      .asDownhill()
      .atPoint(-122.9, 50.1)
      .fromOpenStreetMap("way/12345")
      .build(),

  /**
   * A Nordic ski area
   */
  nordicCenter: () =>
    SkiAreaBuilder.create("nordic-test")
      .withName("Nordic Center")
      .asNordic()
      .atPoint(-121.5, 49.5)
      .fromOpenStreetMap("way/23456")
      .build(),

  /**
   * A ski area with both downhill and nordic activities
   */
  mixedResort: () =>
    SkiAreaBuilder.create("mixed-test")
      .withName("Mixed Resort")
      .withActivities(SkiAreaActivity.Downhill, SkiAreaActivity.Nordic)
      .atPoint(-120.0, 48.0)
      .fromOpenStreetMap("relation/34567")
      .build(),

  /**
   * A ski area from Skimap.org
   */
  skimapOrgArea: () =>
    SkiAreaBuilder.create("skimap-test")
      .withName("Skimap Resort")
      .asDownhill()
      .atPoint(-118.0, 47.0)
      .fromSkiMapOrg("12345")
      .build(),

  /**
   * A ski area with polygon geometry
   */
  withPolygon: () =>
    SkiAreaBuilder.create("polygon-test")
      .withName("Polygon Resort")
      .asDownhill()
      .withPolygon([
        [
          [-122.0, 50.0],
          [-121.9, 50.0],
          [-121.9, 50.1],
          [-122.0, 50.1],
          [-122.0, 50.0],
        ],
      ])
      .fromOpenStreetMap("way/45678")
      .build(),

  /**
   * An abandoned ski area
   */
  abandoned: () =>
    SkiAreaBuilder.create("abandoned-test")
      .withName("Closed Mountain")
      .asDownhill()
      .asClosed()
      .atPoint(-123.0, 51.0)
      .fromOpenStreetMap("way/56789")
      .build(),

  /**
   * A ski area with statistics
   */
  withStatistics: () =>
    SkiAreaBuilder.create("stats-test")
      .withName("Stats Resort")
      .asDownhill()
      .atPoint(-119.0, 46.0)
      .withStatistics({
        runs: {
          byActivity: {
            downhill: {
              byDifficulty: {
                novice: { count: 5, lengthInKm: 2.5 },
                easy: { count: 10, lengthInKm: 8.0 },
                intermediate: { count: 15, lengthInKm: 12.0 },
                advanced: { count: 8, lengthInKm: 6.0 },
                expert: { count: 3, lengthInKm: 2.0 },
                freeride: { count: 2, lengthInKm: 1.5 },
                extreme: { count: 1, lengthInKm: 0.5 },
              },
            },
          },
        },
        lifts: {
          byType: {},
        },
        maxElevation: 2500,
        minElevation: 1200,
      })
      .fromOpenStreetMap("relation/67890")
      .build(),
};
