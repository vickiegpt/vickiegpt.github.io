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
import argparse
import requests

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
    """Update the shields.io JSON file with new citation count.

    Returns:
        (success: bool, changed: bool)
    """
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
                    return True, False
        
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
        return True, True
        
    except Exception as e:
        print(f"Error updating JSON file: {e}")
        return False, False


def notify_discord(webhook_url: str, content: str, username: str = None):
    """Send a notification to a Discord webhook."""
    if not webhook_url:
        print("No Discord webhook URL provided; skipping notification.")
        return False
    payload = {"content": content}
    if username:
        payload["username"] = username
    try:
        resp = requests.post(webhook_url, json=payload, timeout=15)
        if 200 <= resp.status_code < 300:
            print("Discord notification sent.")
            return True
        else:
            print(f"Discord webhook failed: {resp.status_code} {resp.text}")
            return False
    except Exception as e:
        print(f"Error sending Discord notification: {e}")
        return False

def main():
    """Main function"""
    parser = argparse.ArgumentParser(description="Update Google Scholar citation count and optionally notify Discord if changed.")
    parser.add_argument("--webhook", dest="webhook", default=os.environ.get("DISCORD_WEBHOOK_URL"), help="Discord webhook URL for change notifications")
    parser.add_argument("--username", dest="username", default=os.environ.get("DISCORD_WEBHOOK_USERNAME", None), help="Override username shown in Discord")
    parser.add_argument("--mention", dest="mention", default=os.environ.get("DISCORD_MENTION", None), help="Extra text to include in notification (e.g., @role or label)")
    args = parser.parse_args()

    print(f"Starting citation update at {datetime.now()}")
    print(f"Fetching citations for Scholar ID: {SCHOLAR_ID}")
    
    # Try scholarly method
    citation_count = get_citation_count_scholarly()
    
    if citation_count is not None:
        print(f"Found {citation_count} citations")
        
        # Update JSON file
        ok, changed = update_json_file(citation_count)
        if not ok:
            print("Failed to update JSON file")
            sys.exit(1)

        if changed:
            print("Detected change in citation count; notifying...")
            timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%SZ")
            extra = f" {args.mention}" if args.mention else ""
            message = f"Citations updated to {citation_count} for {SCHOLAR_ID} at {timestamp}.{extra}"
            notify_discord(args.webhook, message, username=args.username or "ggscholar")
        else:
            print("No change detected; no notification sent.")
        print("Update completed successfully")
    else:
        print("Failed to fetch citation count")
        print("The scholarly library couldn't fetch from Google Scholar")
        sys.exit(1)

if __name__ == "__main__":
    main()
