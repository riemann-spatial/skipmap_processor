# OpenSkiData Processor

This is a data pipeline that consumes OpenStreetMap & Skimap.org data and produces GeoJSON & Mapbox GL tiles for usage on [OpenSkiMap.org](https://github.com/russellporter/openskimap.org).

## Installation & Usage

### Docker (Recommended)

**Production:**

```bash
# Build the processor
docker build -t openskidata-processor .

docker rm -f openskidata-processor 2>/dev/null || true

# Run the processor (container stays running for external commands)
# - PostgreSQL runs inside the container and listens on 5432
# - Publish it on host port 5433 so you can connect from the host
# - Set POSTGRES_USER/POSTGRES_PASSWORD to avoid "trust auth" when exposing the port
docker run -d --name openskidata-processor \
  -p 5433:5432 \
  -e POSTGRES_USER=dev \
  -e POSTGRES_PASSWORD=dev \
  # Optional: limit downloads to a bounding box: [minLon, minLat, maxLon, maxLat]
  # Use quotes so JSON parses correctly inside the container.
  -e BBOX='[10.74827, 46.81017, 11.08733, 47.00510]' \
  -v $(pwd)/data:/app/data \
  openskidata-processor

docker run -d --name openskidata-processor -p 5433:5432 -e POSTGRES_USER=dev -e POSTGRES_PASSWORD=dev -e BBOX='[10.74827, 46.81017, 11.08733, 47.00510]' -v $(pwd)/data:/app/data  openskidata-processor

# Execute the processing pipeline
docker exec openskidata-processor ./run.sh

# Or run specific commands
docker exec openskidata-processor npm run download
docker exec openskidata-processor npm run prepare-geojson
```

**Rootless Docker note (Linux):** if you see `EACCES: permission denied` when writing files under `data/`,
run commands as the `node` user (UID 1000 in the image, commonly matching your host user) or adjust the
permissions of your local `./data` directory.

```bash
# Run pipeline as the node user (recommended for rootless Docker)
docker exec --user node openskidata-processor ./run.sh
```

If the container is already running and you just want to try a one-off bbox without recreating it:

```bash
docker exec -e BBOX='[10.74827, 46.81017, 11.08733, 47.00510]' openskidata-processor ./run.sh
```

If you keep getting Overpass `504` errors (public instances can be overloaded), you can provide a list of
alternative Overpass endpoints (comma-separated) and the downloader will try them in order:

```bash
docker run -d --name openskidata-processor \
  -p 5433:5432 \
  -e POSTGRES_USER=dev \
  -e POSTGRES_PASSWORD=dev \
  -e BBOX='[10.74827, 46.81017, 11.08733, 47.00510]' \
  -e OVERPASS_ENDPOINTS='https://overpass.kumi.systems/api/interpreter,https://z.overpass-api.de/api/interpreter,https://lz4.overpass-api.de/api/interpreter' \
  -v $(pwd)/data:/app/data \
  openskidata-processor
```

**Query PostgreSQL from outside the container:**

```bash
# From the host (requires a local psql client: `sudo apt install postgresql-client`)
psql -h localhost -p 5433 -U dev openskidata_cache
```

**What is stored in PostgreSQL?**

- The processor's primary outputs are written to files under `./data/` (GeoJSON, CSV, GeoPackage, mbtiles).
- PostgreSQL is used for **caching** (optional features like geocoding/elevation/snow-cover caches) and for an **internal temporary clustering database**.
  During a run you'll see logs like `✅ Created temporary database: clustering-...` and `✅ Deleted temporary database: clustering-...` — that database is expected to be dropped at the end of the run.
  Cache tables are created on-demand; if you haven't enabled any cache-backed features, the databases may appear "empty" aside from PostGIS metadata tables.

**Development:**

```bash
# Start development environment
docker compose up -d

# Run commands
docker compose exec app npm test
docker compose exec app npm run check-types
docker compose exec app ./run.sh

# Or get a shell
docker compose exec app bash
```

**Note:** The Docker container runs in daemon mode and stays running to allow external command execution. Use `docker exec` or `docker compose exec` to run processing commands inside the container.

To download data for only a specific area, specify a GeoJSON format bounding box in an environment variable: `BBOX="[-13, -90, 65, 90]"`

The output is placed in files within the `data` folder. The output location can be overridden by setting `OUTPUT_DIR`.

The GeoPackage file (`openskidata.gpkg`) contains all three layers (ski areas, runs, and lifts) in a single file, making it easy to use with GIS software like QGIS.

The processor is RAM hungry. `MAX_OLD_SPACE_SIZE` can be set to adjust the memory usage of the node process, it defaults to 4GB which is sufficient for most cases.

### Advanced

For quick development iterations, `./run.sh --skip-download` uses the previously downloaded data.

## Optional Features

### Caching

To speed up subsequent runs of the processor, some data (elevations, geocodes, snow cover) is cached in PostgreSQL. The cache is stored in a database named `openskidata_cache` (configurable via environment variables).

**Clearing caches:**

To clear cached data, use the interactive cache clearing utility:

```bash
docker compose exec app npm run clear-cache
```

This will show you each cache table with its size and row count, and prompt you to confirm clearing each one.

### Elevation data

Features will be augmented with elevation data.

The processor supports multiple elevation sources:

**Racemap:**
Set `ELEVATION_SERVER_URL` to an endpoint that can receive POST requests in the format of https://github.com/racemap/elevation-service.
You should use a local instance of the elevation server because a large number of requests will be performed.

```bash
ELEVATION_SERVER_URL="https://elevation.racemap.com/api"
ELEVATION_SERVER_TYPE="racemap"
```

**Tileserver GL:**
For elevation data served via [Tileserver GL](https://tileserver.readthedocs.io/en/latest/endpoints.html#source-data) with RGB-encoded elevation tiles. Configure using the batch elevation endpoint:

```bash
ELEVATION_SERVER_URL="https://example.com/data/mydata/elevation"
ELEVATION_SERVER_TYPE="tileserver-gl"
ELEVATION_SERVER_ZOOM="14,12"  # optional, comma-separated list of zoom levels to try in order, defaults to 12
```

The processor uses the batch POST endpoint (`/data/{id}/elevation`) to fetch elevations for multiple coordinates at once. It will attempt each zoom level in order, falling back to the next zoom level for coordinates that return null (no data available).

**WCS (GeoTIFF via GetCoverage):**
For regional DEM datasets published as an OGC WCS endpoint that can return GeoTIFF. Example (Tyrol terrain WCS):
[`GetCapabilities`](https://gis.tirol.gv.at/arcgis/services/Service_Public/terrain/MapServer/WCSServer?request=GetCapabilities&service=WCS)

```bash
ELEVATION_SERVER_URL="https://gis.tirol.gv.at/arcgis/services/Service_Public/terrain/MapServer/WCSServer"
ELEVATION_SERVER_TYPE="wcs"
ELEVATION_SERVER_ZOOM="15"
ELEVATION_WCS_COVERAGE_ID="Gelaendemodell_5m_M28"
ELEVATION_WCS_VERSION="1.0.0"        # optional (default: 1.0.0)
ELEVATION_WCS_FORMAT="image/tiff"    # optional (default: GeoTIFF)
ELEVATION_WCS_CRS="EPSG:4326"        # optional (default: EPSG:4326)
# EPSG:4326 axis order can be server-dependent; try lonlat first, then latlon if you get empty/shifted results.
ELEVATION_WCS_AXIS_ORDER="lonlat"    # optional (default: lonlat)
ELEVATION_WCS_TILE_SIZE="256"        # optional (default: 256)
ELEVATION_WCS_NODATA_VALUE="-32768"  # optional (default: -32768)
```

### Reverse geocoding

Features will be augmented with country/region/locality information.

The processor supports two geocoding service formats:

**Photon:**
Set `GEOCODING_SERVER_URL` to an endpoint that reverse geocodes in the format of https://photon.komoot.io/reverse:

```bash
GEOCODING_SERVER_URL="https://photon.komoot.io/reverse"
GEOCODING_SERVER_TYPE="photon"  # optional, this is the default
```

**geocode-api (Who's On First):**
Set `GEOCODING_SERVER_URL` to an endpoint in the format of https://github.com/russellporter/geocode-api:

```bash
GEOCODING_SERVER_URL="http://localhost:3000/reverse"
GEOCODING_SERVER_TYPE="geocode-api"
```

Geocoding results are cached in PostgreSQL in type-specific tables for faster subsequent runs of the processor.

### Snow cover data

Ski areas and runs can be augmented with VIIRS satellite snow cover data.

**Setup:**

1. Follow installation instructions in the `snow-cover/` directory
2. Set up NASA Earthdata authentication (see snow-cover README)
3. Enable with `ENABLE_SNOW_COVER=1` when running the processor

Note: Snow cover data is included in the output when enabled.

**Fetch policies** (`SNOW_COVER_FETCH_POLICY`):

- `full` (default) - fetch all required snow cover data that is not already cached
- `incremental` - only extend already cached data with new temporal data
- `none` - do not fetch any new snow cover data, only use cached data

Incremental fetching is useful for long term deployments where you want to keep the existing data up to date without fetching data for new locations. The data is cached at pixel resolution (375m), so a new run can trigger a large data fetch of historical data when using the 'full' policy just to fill one pixel worth of data. Therefore its recommended to only use `full` occasionally (annually) to fill gaps created by runs in new locations.

Note: uses of this data must cite the [source](https://nsidc.org/data/vnp10a1/versions/2) as follows:

Riggs, G. A. & Hall, D. K. (2023). VIIRS/NPP Snow Cover Daily L3 Global 375m SIN Grid. (VNP10A1, Version 2). Boulder, Colorado USA. NASA National Snow and Ice Data Center Distributed Active Archive Center. https://doi.org/10.5067/45VDCKJBXWEE.

### Mapbox Vector Tiles

Pass `GENERATE_MBTILES=1` to enable generation of Mapbox Vector Tiles (MVT) output. This will output an `.mbtiles` file in the output directory.

## Issue reporting

Feature requests and bug reports are tracked in the [main project repo](https://github.com/russellporter/openskimap.org/issues/).
