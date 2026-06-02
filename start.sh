#!/bin/bash
# Stream Lurker Linux Launcher

echo "==================================================="
echo "            Initializing Stream Lurker..."
echo "==================================================="

# Navigate to the script's directory
cd "$(dirname "$0")"

# Install dependencies if node_modules does not exist
if [ ! -d "node_modules" ]; then
    echo "Installing root dependencies..."
    npm install
fi

echo "Launching application..."
npm start
