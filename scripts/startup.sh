#!/bin/bash

# Startup script for openskidata-processor
# Starts PostgreSQL in the background and waits for it to be ready,
# then runs the processing pipeline.

set -e

echo "=== OpenSkiData Processor Startup ==="

# Start PostgreSQL initialization in background
echo "Starting PostgreSQL..."
/usr/local/bin/init-postgres.sh &
POSTGRES_PID=$!

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if pg_isready -h localhost -p 5432 -U "${POSTGRES_USER:-postgres}" > /dev/null 2>&1; then
        echo "PostgreSQL is ready!"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "Waiting for PostgreSQL... (attempt $RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "ERROR: PostgreSQL failed to start within the timeout period"
    exit 1
fi

# Check if COMPILE_NEW is set to false (case-insensitive)
COMPILE_NEW_LOWER=$(echo "${COMPILE_NEW:-true}" | tr '[:upper:]' '[:lower:]')

if [ "$COMPILE_NEW_LOWER" = "false" ] || [ "$COMPILE_NEW_LOWER" = "0" ]; then
    echo "COMPILE_NEW is false - skipping data compilation, PostgreSQL is running."
    echo "Connect to PostgreSQL at localhost:5432 (or mapped port from host)"
else
    # Install npm dependencies if needed
    if [ ! -d "node_modules" ] || [ ! -f "node_modules/.package-lock.json" ]; then
        echo "Installing npm dependencies..."
        npm install
    fi

    # Run the processing pipeline
    echo "Starting OpenSkiData processing..."
    ./run.sh

    echo "Processing complete!"
fi

# Keep the container running by waiting for PostgreSQL
wait $POSTGRES_PID
