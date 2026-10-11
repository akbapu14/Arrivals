"""Vercel serverless function for live flight positions."""

from http.server import BaseHTTPRequestHandler
import json
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin': 'https://www.flightradar24.com',
    'Referer': 'https://www.flightradar24.com/',
}


def fetch_position(flight_id):
    """Fetch live flight position for a single flight ID."""
    try:
        url = f"https://data-live.flightradar24.com/clickhandler/?flight={flight_id}"
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read())

        trail = data.get('trail', [])

        # Get live ETA from FR24's real-time tracking
        time_data = data.get('time', {})
        live_eta = time_data.get('estimated', {}).get('arrival') or time_data.get('other', {}).get('eta')

        if trail and len(trail) > 0:
            latest = trail[0]
            if isinstance(latest, dict):
                return {
                    'alt': latest.get('alt'),
                    'lat': latest.get('lat'),
                    'lon': latest.get('lng'),
                    'heading': latest.get('hd'),
                    'speed': latest.get('spd'),
                    'live_eta': live_eta
                }
            if isinstance(latest, list) and len(latest) >= 5:
                return {
                    'alt': latest[2],
                    'lat': latest[0],
                    'lon': latest[1],
                    'heading': latest[4] if len(latest) > 4 else None,
                    'speed': latest[3] if len(latest) > 3 else None,
                    'live_eta': live_eta
                }
    except Exception:
        return None
    return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        flight_ids = query.get('ids', [''])[0].split(',')
        flight_ids = [fid for fid in flight_ids if fid][:60]

        positions = {}

        if flight_ids:
            with ThreadPoolExecutor(max_workers=10) as executor:
                futures = {executor.submit(fetch_position, fid): fid for fid in flight_ids}
                for future in as_completed(futures):
                    fid = futures[future]
                    try:
                        pos = future.result()
                        if pos:
                            positions[fid] = pos
                    except Exception:
                        continue

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'public, max-age=5')
        self.end_headers()
        self.wfile.write(json.dumps({'positions': positions}).encode())
