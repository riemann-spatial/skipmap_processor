#!/bin/bash
set -e

MY_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd $MY_DIR

RUN_MODE=$1
DOWNLOAD=true

# Parse command line options
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --skip-download)
            DOWNLOAD=false
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

# Reset the openskidata database tables
echo "Resetting openskidata database tables..."
PGPASSWORD="${POSTGRES_PASSWORD}" psql -h localhost -U "${POSTGRES_USER:-postgres}" -d openskidata << 'EOSQL'
-- Truncate all input tables
TRUNCATE TABLE input.runs RESTART IDENTITY CASCADE;
TRUNCATE TABLE input.lifts RESTART IDENTITY CASCADE;
TRUNCATE TABLE input.ski_areas RESTART IDENTITY CASCADE;
TRUNCATE TABLE input.ski_area_sites RESTART IDENTITY CASCADE;

-- Truncate all output tables
TRUNCATE TABLE output.runs RESTART IDENTITY CASCADE;
TRUNCATE TABLE output.lifts RESTART IDENTITY CASCADE;
TRUNCATE TABLE output.ski_areas RESTART IDENTITY CASCADE;

-- Truncate clustering working table
TRUNCATE TABLE objects RESTART IDENTITY;

EOSQL
echo "Database tables reset complete."

if [ "$DOWNLOAD" = true ]; then
    echo "Downloading..."
    npm run download
fi

echo "Preparing OpenSkiData..."
npm run prepare-geojson
