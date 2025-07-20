#!/bin/bash

echo "Testing citation update script..."

# Navigate to script directory
cd "$(dirname "$0")"

# Check if virtual environment exists, if not create it
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install requirements
echo "Installing requirements..."
pip install -r ../requirements.txt

# Run the script
echo "Running citation update..."
python update_citations_scholarly.py

# Check if the JSON file was updated
if [ -f "../about/gs_data_shieldsio.json" ]; then
    echo "JSON file content:"
    cat ../about/gs_data_shieldsio.json
else
    echo "JSON file not found!"
fi

# Deactivate virtual environment
deactivate