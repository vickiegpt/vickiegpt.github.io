#!/usr/bin/env python3
"""
Alternative script using scholarly library to fetch citation count from Google Scholar
This is more reliable than web scraping
"""

import json
import os
from datetime import datetime
from scholarly import scholarly
import time
import sys

# Configuration
SCHOLAR_ID = "sDUT22MAAAAJ"
JSON_FILE_PATH = "../about/gs_data_shieldsio.json"

def get_citation_count_scholarly():
    """Fetch citation count using scholarly library"""
    try:
        print("Searching for author profile...")
        
        # Search by Scholar ID
        author = scholarly.search_author_id(SCHOLAR_ID)
        
        # Fill in the author information (this fetches additional details)
        author = scholarly.fill(author, sections=['basics', 'indices'])
        
        # Get citation count
        if 'citedby' in author:
            return author['citedby']
        
        # Alternative: check indices
        if 'indices' in author:
            # The first index is usually total citations
            indices = author.get('indices', [])
            if indices and len(indices) > 0:
                return indices[0]
        
        print("Warning: Could not find citation count in author data")
        return None
        
    except Exception as e:
        print(f"Error fetching data with scholarly: {e}")
        return None

def update_json_file(citation_count):
    """Update the shields.io JSON file with new citation count"""
    try:
        # Get the directory of the script
        script_dir = os.path.dirname(os.path.abspath(__file__))
        json_path = os.path.join(script_dir, JSON_FILE_PATH)
        
        # Ensure the directory exists
        os.makedirs(os.path.dirname(json_path), exist_ok=True)
        
        # Read existing data to check if update is needed
        if os.path.exists(json_path):
            with open(json_path, 'r') as f:
                existing_data = json.load(f)
                existing_count = existing_data.get('message', '0')
                if str(citation_count) == existing_count:
                    print(f"Citation count unchanged: {citation_count}")
                    return True
        
        # Create the shields.io compatible JSON
        data = {
            "schemaVersion": 1,
            "label": "citations",
            "message": str(citation_count),
            "color": "blue"
        }
        
        # Write to file (shields.io only needs the basic fields)
        with open(json_path, 'w') as f:
            json.dump(data, f)
        
        print(f"Successfully updated {json_path} with citation count: {citation_count}")
        return True
        
    except Exception as e:
        print(f"Error updating JSON file: {e}")
        return False

def main():
    """Main function"""
    print(f"Starting citation update at {datetime.now()}")
    print(f"Fetching citations for Scholar ID: {SCHOLAR_ID}")
    
    # Try scholarly method
    citation_count = get_citation_count_scholarly()
    
    if citation_count is not None:
        print(f"Found {citation_count} citations")
        
        # Update JSON file
        if update_json_file(citation_count):
            print("Update completed successfully")
        else:
            print("Failed to update JSON file")
            sys.exit(1)
    else:
        print("Failed to fetch citation count")
        # Try the web scraping method as fallback
        print("Trying web scraping method...")
        from update_citations import get_citation_count
        citation_count = get_citation_count()
        if citation_count is not None:
            print(f"Found {citation_count} citations (via web scraping)")
            if update_json_file(citation_count):
                print("Update completed successfully")
            else:
                print("Failed to update JSON file")
                sys.exit(1)
        else:
            print("Both methods failed")
            sys.exit(1)

if __name__ == "__main__":
    main()