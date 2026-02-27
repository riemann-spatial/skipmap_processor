#!/bin/bash
set -e

MY_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd $MY_DIR

DOWNLOAD=true
# Allow EXPORT_ONLY to be set via environment variable (e.g. docker-compose.yml)
EXPORT_ONLY=${EXPORT_ONLY:-false}
# Normalize: treat "1" from env the same as "true" from --export-only flag
if [ "$EXPORT_ONLY" = "1" ]; then
    EXPORT_ONLY=true
fi
# Allow START_AT_ASSOCIATING_HIGHWAYS to be set via environment variable
START_AT_ASSOCIATING_HIGHWAYS=${START_AT_ASSOCIATING_HIGHWAYS:-false}
if [ "$START_AT_ASSOCIATING_HIGHWAYS" = "1" ]; then
    START_AT_ASSOCIATING_HIGHWAYS=true
fi
# Allow CONTINUE_WITH_DEM to be set via environment variable
CONTINUE_WITH_DEM=${CONTINUE_WITH_DEM:-false}
if [ "$CONTINUE_WITH_DEM" = "1" ]; then
    CONTINUE_WITH_DEM=true
fi

# Parse command line options
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --skip-download)
            DOWNLOAD=false
            ;;
        --export-only)
            EXPORT_ONLY=true
            ;;
        --continue-with-dem)
            CONTINUE_WITH_DEM=true
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
    shift
done

# Only build in development mode or if dist doesn't exist
if [ "$NODE_ENV" != "production" ] || [ ! -d "dist" ]; then
    echo "Building..."
    npm run build
else
    echo "Skipping build (production mode and dist exists)"
fi

if [ "$EXPORT_ONLY" = true ]; then
    echo "Export-only mode: skipping database init and download"
    echo "Preparing OpenSkiData (export only)..."
    EXPORT_ONLY=1 npm run prepare-ski-data
elif [ "$START_AT_ASSOCIATING_HIGHWAYS" = true ]; then
    echo "Resuming from highway association: skipping database init and download"
    echo "Preparing OpenSkiData (highway association only)..."
    START_AT_ASSOCIATING_HIGHWAYS=1 npm run prepare-ski-data
elif [ "$CONTINUE_WITH_DEM" = true ]; then
    echo "Resuming from DEM elevation: skipping database init and download"
    echo "Preparing OpenSkiData (continue with DEM)..."
    CONTINUE_WITH_DEM=1 npm run prepare-ski-data
else
    if [ "$DOWNLOAD" = true ]; then
        # Initialize database (creates/recreates processing database with schema)
        echo "Initializing database..."
        npm run init-database

        echo "Downloading..."
        npm run download
    fi

    echo "Preparing OpenSkiData..."
    npm run prepare-ski-data
fi
