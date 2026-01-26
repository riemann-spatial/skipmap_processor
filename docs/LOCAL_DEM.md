# Local DEM File Support

This guide explains how to download, prepare, and use local Digital Elevation Model (DEM) files for elevation enrichment in openskidata-processor.

## Overview

The local DEM feature allows you to use high-resolution elevation data from local GeoTIFF files. **AWS Terrain Tiles automatically fills in gaps** for any coordinates outside your local DEM coverage - no configuration needed.

This is particularly useful for:

- Areas with high-resolution national DEM datasets (e.g., French RGE ALTI, Swiss swissALTI3D)
- Better elevation accuracy than global datasets (~1m vs ~30m resolution)
- Faster processing with cached local data

## Prerequisites

- Docker and docker-compose
- Sufficient disk space for DEM files (can be several GB per region)
- The DEM source data (see [Data Sources](#data-sources) below)

## Quick Start

```bash
# 1. Create the Docker volume for DEM data
docker volume create dem_data

# 2. Rebuild the container (if needed, to get gdal-bin and p7zip)
docker compose build

# 3. Prepare your DEM files (example with French RGE ALTI)
docker compose exec app ./scripts/prepare-dem.sh \
    /path/to/RGEALTI_D073.7z.001 \
    /data/dem \
    EPSG:2154

# 4. Configure environment variables in docker-compose.yml (see Configuration below)

# 5. Run the processor
docker compose exec app ./run.sh
```

## Data Sources

### French RGE ALTI (IGN)

High-resolution (1m or 5m) elevation data for France.

**Download:**

1. Go to [IGN Geoservices](https://geoservices.ign.fr/rgealti)
2. Select your department (e.g., D073 for Savoie, D074 for Haute-Savoie)
3. Download the ASC format with Lambert 93 projection (LAMB93-IGN69)
4. Files are split 7z archives (e.g., `RGEALTI_2-0_1M_ASC_LAMB93-IGN69_D073_2020-10-15.7z.001` and `.7z.002`)

**Note on split archives:** Download ALL parts (`.7z.001`, `.7z.002`, etc.) and keep them in the same directory. When extracting, only reference the `.001` file - 7z automatically finds the other parts.

**Projection:** EPSG:2154 (Lambert 93)

**Example departments for ski areas:**
| Department | Code | Coverage |
|------------|------|----------|
| Savoie | D073 | Val d'Isère, Tignes, Les Arcs, La Plagne |
| Haute-Savoie | D074 | Chamonix, Megève, Morzine, Avoriaz |
| Isère | D038 | Alpe d'Huez, Les Deux Alpes |
| Hautes-Alpes | D005 | Serre Chevalier, Montgenèvre |

### Swiss swissALTI3D (swisstopo)

High-resolution (0.5m or 2m) elevation data for Switzerland.

**Download:**

1. Go to [swisstopo geodata](https://www.swisstopo.admin.ch/en/geodata/height/alti3d.html)
2. Download tiles in GeoTIFF format

**Projection:** EPSG:2056 (CH1903+ / LV95)

### Austrian DEM (data.gv.at)

Various resolution DEMs available for Austria.

**Download:**

1. Go to [data.gv.at](https://www.data.gv.at/)
2. Search for "Geländemodell" or "DGM"
3. Download regional datasets

**Projection:** Varies by region (commonly EPSG:31287 MGI / Austria Lambert)

## Preparing DEM Files

The processor requires GeoTIFF files reprojected to WGS84 (EPSG:4326). Use the provided script to convert source files:

### Using the prepare-dem.sh Script

The script extracts archives, finds all DEM files (`.asc`, `.tif`, `.tiff`), reprojects them to WGS84, and converts to Cloud-Optimized GeoTIFF format.

```bash
# Extract and convert a split 7z archive (French RGE ALTI)
# Note: For split archives (.7z.001, .7z.002, ...), only specify the .001 file.
# All parts must be in the same directory - 7z finds them automatically.
docker compose exec app ./scripts/prepare-dem.sh \
    /path/to/RGEALTI_D073.7z.001 \
    /data/dem \
    EPSG:2154

# Convert a single ASC file
docker compose exec app ./scripts/prepare-dem.sh \
    /path/to/dem_tile.asc \
    /data/dem \
    EPSG:2154

# Convert an already georeferenced GeoTIFF (will reproject to WGS84)
docker compose exec app ./scripts/prepare-dem.sh \
    /path/to/dem.tif \
    /data/dem \
    EPSG:2056
```

**Progress reporting:** For large archives (e.g., French RGE ALTI with ~10,000+ tiles), the script shows progress every 500 files and reports any conversion failures. Existing output files are skipped, so you can safely re-run the script if interrupted.

**Processing time:** Converting ~10,000 tiles takes approximately 30-60 minutes depending on your system. Each file is reprojected and converted to COG format.

### Manual Conversion with GDAL

If you prefer manual conversion:

```bash
# Step 1: Reproject to WGS84
gdalwarp \
    -s_srs EPSG:2154 \
    -t_srs EPSG:4326 \
    -r bilinear \
    input.asc reprojected.tif

# Step 2: Convert to Cloud-Optimized GeoTIFF (COG)
gdal_translate \
    -of COG \
    -co COMPRESS=DEFLATE \
    -co PREDICTOR=2 \
    reprojected.tif /data/dem/output.tif
```

### Copying Files to Docker Volume

If you prepared files outside the container:

```bash
# Copy a single file
docker cp output.tif openskidata-processor:/data/dem/

# Copy multiple files
docker cp ./prepared_dems/. openskidata-processor:/data/dem/

# Or mount a local directory instead of using a volume (modify docker-compose.yml):
# volumes:
#   - /path/to/local/dem/files:/data/dem:ro
```

## Configuration

### Environment Variables

Add these to your `docker-compose.yml`:

```yaml
environment:
  - ELEVATION_SERVER_TYPE=local-dem
  - LOCAL_DEM_DIRECTORY=/data/dem
```

That's it! Just two lines. AWS Terrain Tiles automatically fills gaps for coordinates outside your local DEM coverage.

### Volume Mount

Ensure the `dem_data` volume is mounted in `docker-compose.yml`:

```yaml
volumes:
  - dem_data:/data/dem:ro

# At the bottom of the file:
volumes:
  dem_data:
    external: true  # Create with: docker volume create dem_data
```

### Full Example Configuration

```yaml
services:
  app:
    volumes:
      - .:/app
      - dem_data:/data/dem:ro
    environment:
      - BBOX=[6.4,45.2,7.2,46.0] # Savoie region
      - ELEVATION_SERVER_TYPE=local-dem
      - LOCAL_DEM_DIRECTORY=/data/dem

volumes:
  dem_data:
    external: true
```

## How It Works

1. **Initialization**: On first elevation request, the processor scans `/data/dem` for `.tif` files and extracts their bounding boxes
2. **Spatial Lookup**: For each coordinate, the processor finds which DEM file (if any) contains that location
3. **Elevation Extraction**: Elevations are read from GeoTIFF files using windowed reads (memory-efficient)
4. **Interpolation**: Bilinear interpolation is used by default for sub-pixel accuracy
5. **Automatic Fallback**: Coordinates outside local DEM coverage automatically use AWS Terrain Tiles
6. **Retry Logic**: Network requests (for AWS fallback) automatically retry on transient failures with exponential backoff

## Troubleshooting

### "No GeoTIFF files found in /data/dem"

- Verify the volume is mounted: `docker compose exec app ls -la /data/dem`
- Check file permissions: files should be readable
- Ensure files have `.tif` or `.tiff` extension

### "GeoTIFF has invalid or non-WGS84 bounds"

The GeoTIFF file needs to be reprojected to EPSG:4326 (WGS84). Use the prepare-dem.sh script with the correct source CRS:

```bash
docker compose exec app ./scripts/prepare-dem.sh input.tif /data/dem EPSG:2154
```

### "LOCAL_DEM_DIRECTORY not configured"

Add the environment variable to docker-compose.yml:

```yaml
- LOCAL_DEM_DIRECTORY=/data/dem
```

### Slow initialization with many files

The index is built once and cached. For many files (>20), consider merging tiles into larger regional files using GDAL:

```bash
gdal_merge.py -o merged.tif -co COMPRESS=DEFLATE tile1.tif tile2.tif tile3.tif
gdal_translate -of COG merged.tif /data/dem/region.tif
```

### Elevation values seem wrong

1. Verify the source CRS was correct during conversion
2. Check that interpolation is enabled: `INTERPOLATE_HEIGHT_INFORMATION=true`
3. Compare with known elevation points from the source data

### "Partial elevation data" warnings in logs

This means some coordinates couldn't get elevation data. Common causes:

- Coordinates are outside both local DEM and AWS coverage (e.g., invalid coordinates like `[360, 360]`)
- Network issues when fetching from AWS fallback (retries are automatic)
- The message shows how many coordinates were affected - a few missing points is normal for edge cases

## Performance Considerations

- **File Size**: COG format with DEFLATE compression typically reduces file size by 50-70%
- **Memory**: Files are read using windowed reads, so large files don't consume excessive memory
- **Caching**: GeoTIFF data is cached in memory after first read for faster subsequent lookups
- **Fallback Overhead**: Using a fallback adds network latency for coordinates outside local coverage

## File Organization

Recommended structure for the DEM volume:

```
/data/dem/
├── france_savoie.tif       # French Savoie region
├── france_haute_savoie.tif # French Haute-Savoie region
├── switzerland_valais.tif  # Swiss Valais region
└── austria_tyrol.tif       # Austrian Tyrol region
```

Files can overlap - the processor will use the first matching file found.
