#!/bin/bash
#
# Prepare DEM files for use with openskidata-processor local-dem elevation source.
# Extracts 7z archives and converts ASC files to Cloud-Optimized GeoTIFF (COG) with WGS84 projection.
#
# Usage:
#   ./prepare-dem.sh <input_7z_or_asc> <output_directory> [source_crs]
#
# Examples:
#   # Extract and convert French RGE ALTI split 7z archive (Lambert 93/EPSG:2154)
#   # For split archives (.7z.001, .7z.002, ...), only specify the .001 file.
#   # All parts must be in the same directory - 7z finds them automatically.
#   ./prepare-dem.sh RGEALTI_2-0_1M_ASC_LAMB93-IGN69_D073_2020-10-15.7z.001 /data/dem EPSG:2154
#
#   # Convert a single ASC file (auto-detect CRS from .prj if available)
#   ./prepare-dem.sh dem_tile.asc /data/dem
#
#   # Convert existing GeoTIFF to COG with WGS84
#   ./prepare-dem.sh input.tif /data/dem EPSG:2154
#
# Requirements:
#   - gdal-bin (for gdal_translate, gdalwarp)
#   - p7zip-full (for 7z extraction)
#
# The script will:
#   1. Extract 7z archives if input is a .7z file
#   2. Find all ASC/TIF files in the extracted directory
#   3. Convert each file to Cloud-Optimized GeoTIFF in WGS84 (EPSG:4326)
#   4. Output files to the specified output directory

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check dependencies
check_dependencies() {
    local missing=()

    if ! command -v gdal_translate &> /dev/null; then
        missing+=("gdal-bin")
    fi

    if ! command -v 7z &> /dev/null; then
        missing+=("p7zip-full")
    fi

    if [ ${#missing[@]} -ne 0 ]; then
        log_error "Missing dependencies: ${missing[*]}"
        log_info "Install with: apt-get install ${missing[*]}"
        exit 1
    fi
}

# Convert a single file to Cloud-Optimized GeoTIFF
# Returns 0 on success, 1 on failure
convert_to_cog() {
    local input_file="$1"
    local output_dir="$2"
    local source_crs="$3"

    local basename=$(basename "$input_file")
    local name_without_ext="${basename%.*}"
    local output_file="${output_dir}/${name_without_ext}.tif"

    if [ -f "$output_file" ]; then
        return 0
    fi

    # Create temporary file for intermediate processing
    local temp_file=$(mktemp --suffix=.tif)

    # Step 1: Reproject to WGS84 if source CRS is specified
    if [ -n "$source_crs" ]; then
        if ! gdalwarp \
            -q \
            -s_srs "$source_crs" \
            -t_srs EPSG:4326 \
            -r bilinear \
            -of GTiff \
            "$input_file" "$temp_file" 2>&1; then
            rm -f "$temp_file"
            return 1
        fi

        # Step 2: Convert to COG
        if ! gdal_translate \
            -q \
            -of COG \
            -co COMPRESS=DEFLATE \
            -co PREDICTOR=2 \
            -co NUM_THREADS=ALL_CPUS \
            "$temp_file" "$output_file" 2>&1; then
            rm -f "$temp_file"
            return 1
        fi
    else
        # Direct conversion to COG (assumes already in WGS84 or has embedded CRS)
        if ! gdal_translate \
            -q \
            -of COG \
            -co COMPRESS=DEFLATE \
            -co PREDICTOR=2 \
            -co NUM_THREADS=ALL_CPUS \
            "$input_file" "$output_file" 2>&1; then
            rm -f "$temp_file"
            return 1
        fi
    fi

    # Clean up temp file
    rm -f "$temp_file"
    return 0
}

# Extract 7z archive
extract_7z() {
    local archive="$1"
    local extract_dir="$2"

    log_info "Extracting 7z archive: $archive"

    mkdir -p "$extract_dir"
    7z x -o"$extract_dir" "$archive" -y

    log_info "Extracted to: $extract_dir"
}

# Main function
main() {
    local input="$1"
    local output_dir="$2"
    local source_crs="${3:-}"

    if [ -z "$input" ] || [ -z "$output_dir" ]; then
        echo "Usage: $0 <input_7z_or_asc_or_tif> <output_directory> [source_crs]"
        echo ""
        echo "Examples:"
        echo "  $0 RGEALTI_D073.7z.001 /data/dem EPSG:2154  # French RGE ALTI"
        echo "  $0 dem_tile.asc /data/dem EPSG:2154          # Single ASC file"
        echo "  $0 dem_tile.tif /data/dem                    # Already georeferenced TIF"
        echo ""
        echo "Note: For split 7z archives (.7z.001, .7z.002, ...), only specify the .001 file."
        echo "      All parts must be in the same directory - 7z finds them automatically."
        exit 1
    fi

    check_dependencies

    # Create output directory
    mkdir -p "$output_dir"

    # Handle input based on file type
    if [[ "$input" == *.7z* ]]; then
        # Extract 7z archive
        local extract_dir=$(mktemp -d)

        extract_7z "$input" "$extract_dir"

        # Find all ASC and TIF files
        local files=()
        while IFS= read -r -d '' file; do
            files+=("$file")
        done < <(find "$extract_dir" -type f \( -iname "*.asc" -o -iname "*.tif" -o -iname "*.tiff" \) -print0)

        local total=${#files[@]}
        log_info "Found $total DEM file(s) to convert"

        # Convert files with progress
        local count=0
        local failed=0
        for file in "${files[@]}"; do
            if convert_to_cog "$file" "$output_dir" "$source_crs"; then
                count=$((count + 1))
            else
                failed=$((failed + 1))
                if (( failed <= 5 )); then
                    log_warn "Failed to convert: $file"
                fi
            fi
            if (( (count + failed) % 500 == 0 )); then
                log_info "Progress: $count converted, $failed failed / $total total"
            fi
        done

        if (( failed > 0 )); then
            log_warn "Failed to convert $failed file(s)"
        fi

        # Cleanup extracted files
        rm -rf "$extract_dir"

        log_info "Converted $count file(s)"

    elif [[ "$input" == *.asc ]] || [[ "$input" == *.tif ]] || [[ "$input" == *.tiff ]]; then
        # Single file conversion
        convert_to_cog "$input" "$output_dir" "$source_crs"

    else
        log_error "Unsupported file type: $input"
        log_info "Supported formats: .7z, .asc, .tif, .tiff"
        exit 1
    fi

    log_info "Output files in: $output_dir"
    ls -la "$output_dir"/*.tif 2>/dev/null || log_warn "No output files created"
}

main "$@"
