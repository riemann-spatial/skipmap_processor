# Ski Area Discarding

This document describes all circumstances under which a ski area is discarded during processing.

## Discard Reasons

### 1. `NO_OBJECTS` — No runs or lifts assigned (polygon ski areas)

**File:** `src/clustering/services/SkiAreaAssignment.ts`
**When:** During "Assign objects in OSM polygon ski areas" step.
**Condition:** An OSM polygon ski area has `removeIfNoObjectsFound: true` and no runs or lifts were spatially assigned to it.

### 2. `SITE_RELATION_OVERLAP` — Majority of objects already in an OSM site relation

**File:** `src/clustering/services/SkiAreaAssignment.ts`
**When:** Same step as above, for OSM polygon (landuse) ski areas.
**Condition:** More than **50%** of the lifts/runs inside the polygon are already members of an OSM site relation ski area. Controlled by env var `KEEP_LANDUSE_WITH_SITE_OVERLAP` — if set, this check is skipped.
**Rationale:** The polygon is likely a duplicate of the site relation and should defer to it.

### 3. `MULTIPLE_SKIMAP_CONTAINED` — Ambiguous OSM polygon containing multiple Skimap.org areas

**File:** `src/clustering/services/SkiAreaAssignment.ts`
**When:** First step in clustering ("Remove ambiguous duplicate ski areas").
**Condition:** An OSM polygon ski area spatially contains **more than 1** Skimap.org ski area. It's ambiguous which one it corresponds to, so the OSM polygon is removed.

### 4. `NO_RUNS_LIFTS_OSM_ONLY` — OSM-only ski area with nothing assigned

**File:** `src/clustering/services/SkiAreaAugmentation.ts`
**When:** During augmentation (after all clustering/assignment is done).
**Condition:** The ski area has **zero** member objects (runs/lifts) AND has **no Skimap.org source**. Skimap.org-sourced areas are kept even without members because they have curated data.

### 5. `PLACEHOLDER_GEOMETRY` — Never resolved placeholder point

**File:** `src/clustering/services/SkiAreaAugmentation.ts`
**When:** Final cleanup in `removeSkiAreasWithoutGeometry()`.
**Condition:** An OSM ski area still has a placeholder Point geometry with coordinates `[360, 360, id]`. This means it was loaded from an OSM site relation but no real geometry was ever computed from member objects. Detected by `isPlaceholderGeometry()` in `src/utils/PlaceholderSiteGeometry.ts`.

### 6. Implicit removal via **merging** — Skimap.org area merged into nearby OSM area

**File:** `src/clustering/services/SkiAreaMerging.ts`
**When:** "Merge skimap.org and OpenStreetMap ski areas" step.
**Condition:** A Skimap.org ski area is within **0.25 km** of an OSM ski area (based on shared nearby runs/lifts). The Skimap.org area's properties are merged into the OSM area, then the Skimap.org area is **removed** from the database. Not logged as "DISCARDED" but effectively eliminated.

## Processing Order

These checks happen in this sequence (orchestrated in `SkiAreaClusteringService`):

1. Remove ambiguous duplicates (`MULTIPLE_SKIMAP_CONTAINED`)
2. Assign objects to OSM polygon ski areas → discard if `NO_OBJECTS` or `SITE_RELATION_OVERLAP`
3. Assign objects to OSM site relation ski areas
4. Assign objects to Skimap.org ski areas
5. Merge Skimap.org into OSM areas (implicit removal)
6. Augment ski areas → discard `NO_RUNS_LIFTS_OSM_ONLY`
7. Final cleanup → discard `PLACEHOLDER_GEOMETRY`

## Environment Variable

- **`KEEP_LANDUSE_WITH_SITE_OVERLAP=1`** — Disables the `SITE_RELATION_OVERLAP` discard, keeping landuse polygons even when most of their objects are in a site relation.
