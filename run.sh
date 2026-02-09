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

# Parse command line options
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --skip-download)
            DOWNLOAD=false
            ;;
        --export-only)
            EXPORT_ONLY=true
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
    EXPORT_ONLY=1 npm run prepare-geojson
else
    # Initialize database (creates/recreates processing database with schema)
    echo "Initializing database..."
    npm run init-database

    if [ "$DOWNLOAD" = true ]; then
        echo "Downloading..."
        npm run download
    fi

    echo "Preparing OpenSkiData..."
    npm run prepare-geojson
fi
