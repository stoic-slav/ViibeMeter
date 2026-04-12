"""
VibeMeter — Data Export Script
Fetches all data from Supabase and saves to local CSV files for analysis.

Usage:
  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python3 fetch_data.py
"""

import os
import sys
import pandas as pd
from pathlib import Path

def main():
    url = os.environ.get('SUPABASE_URL')
    key = os.environ.get('SUPABASE_SERVICE_KEY')

    if not url or not key:
        print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables")
        sys.exit(1)

    try:
        from supabase import create_client
    except ImportError:
        print("ERROR: supabase package not installed. Run: pip3 install supabase")
        sys.exit(1)

    print("Connecting to Supabase...")
    client = create_client(url, key)

    output_dir = Path(__file__).parent / 'data'
    output_dir.mkdir(exist_ok=True)

    def fetch_table(table_name: str) -> pd.DataFrame:
        print(f"Fetching {table_name}...")
        result = client.table(table_name).select('*').execute()
        df = pd.DataFrame(result.data)
        print(f"  → {len(df)} rows")
        return df

    sessions = fetch_table('sessions')
    windows = fetch_table('sensor_windows')
    ratings = fetch_table('subjective_ratings')

    sessions.to_csv(output_dir / 'sessions.csv', index=False)
    windows.to_csv(output_dir / 'sensor_windows.csv', index=False)
    ratings.to_csv(output_dir / 'ratings.csv', index=False)

    print(f"\n=== Data Summary ===")
    print(f"Sessions:       {len(sessions)}")
    print(f"Sensor windows: {len(windows)}")
    print(f"Ratings:        {len(ratings)}")

    if len(sessions) > 0:
        print(f"Unique devices: {sessions['device_id'].nunique()}")
        if 'venue_type' in sessions.columns:
            print(f"Venue types:    {sessions['venue_type'].value_counts().to_dict()}")
        completed = sessions[sessions['ended_at'].notna()]
        print(f"Completed sessions: {len(completed)}")

    if len(windows) > 0:
        print(f"\n=== Signal Coverage ===")
        for col in ['avg_db', 'estimated_bpm', 'accel_magnitude_avg', 'ble_device_count',
                    'music_detected', 'gps_is_at_venue', 'screen_off_ratio']:
            if col in windows.columns:
                pct = windows[col].notna().mean() * 100
                print(f"  {col:<30}: {pct:.1f}%")

    print(f"\nData saved to {output_dir}/")


if __name__ == '__main__':
    main()
