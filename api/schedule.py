"""Vercel serverless function for airport arrivals schedule."""

from http.server import BaseHTTPRequestHandler
import json
import urllib.request
import urllib.parse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin': 'https://www.flightradar24.com',
    'Referer': 'https://www.flightradar24.com/',
}

WIDEBODY_TYPES = {
    'A332', 'A333', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346',
    'A359', 'A35K', 'A380', 'A388',
    'B744', 'B748', 'B74S', 'B762', 'B763', 'B764',
    'B772', 'B773', 'B77L', 'B77W', 'B778', 'B779',
    'B788', 'B789', 'B78X', 'MD11',
}

def get_flight_details(flight_id):
    """Fetch live flight details including altitude."""
    if not flight_id:
        return None
    try:
        url = f"https://data-live.flightradar24.com/clickhandler/?flight={flight_id}"
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=3) as response:
            data = json.loads(response.read())
            trail = data.get('trail', [])
            if trail and len(trail) > 0:
                latest = trail[0]
                if isinstance(latest, dict):
                    return latest.get('alt')
                elif isinstance(latest, list) and len(latest) >= 3:
                    return latest[2]
    except:
        pass
    return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Parse query params
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        airport = query.get('airport', ['SFO'])[0].upper()

        timestamp = int(time.time())
        all_flights = []

        # Fetch multiple pages (5 pages = 500 flights)
        for page in range(1, 6):
            url = f"https://api.flightradar24.com/common/v1/airport.json?code={airport}&plugin=schedule&plugin-setting%5Bschedule%5D%5Bmode%5D=arrivals&plugin-setting%5Bschedule%5D%5Btimestamp%5D={timestamp}&limit=100&page={page}"
            try:
                req = urllib.request.Request(url, headers=HEADERS)
                with urllib.request.urlopen(req, timeout=10) as response:
                    data = json.loads(response.read())
                    flights = data.get('result', {}).get('response', {}).get('airport', {}).get('pluginData', {}).get('schedule', {}).get('arrivals', {}).get('data', [])
                    all_flights.extend(flights)
            except:
                break

        # Parse into cleaner format
        arrivals = []

        for flight in all_flights:
            f = flight.get('flight') or {}
            aircraft_info = f.get('aircraft') or {}
            model = aircraft_info.get('model') or {}
            ident = f.get('identification') or {}
            airport_data = f.get('airport') or {}
            origin_info = airport_data.get('origin') or {}
            status_info = f.get('status') or {}
            airline_info = f.get('airline') or {}
            time_data = f.get('time') or {}
            est = time_data.get('estimated') or {}
            sched = time_data.get('scheduled') or {}

            arrival = {
                'flight': (ident.get('number') or {}).get('default', ident.get('callsign', '?')),
                'callsign': ident.get('callsign', '?'),
                'type': model.get('code', '?'),
                'typeName': model.get('text', ''),
                'origin': (origin_info.get('code') or {}).get('iata', '?'),
                'originName': origin_info.get('name', ''),
                'status': status_info.get('text', ''),
                'statusColor': status_info.get('icon', ''),
                'airline': airline_info.get('short', airline_info.get('name', '')),
                'eta': est.get('arrival') or sched.get('arrival'),
                'scheduled': sched.get('arrival'),
                'live': status_info.get('live', False),
                'flightId': ident.get('id'),
                'altitude': None,
            }

            arrivals.append(arrival)

        # Prioritize widebody flights for altitude fetch
        live_widebodies = [(i, a['flightId']) for i, a in enumerate(arrivals)
                          if a['live'] and a['flightId'] and a['type'] in WIDEBODY_TYPES]

        # Fetch altitudes in parallel (limit to 10 for Vercel)
        def fetch_alt(item):
            idx, flight_id = item
            return idx, get_flight_details(flight_id)

        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(fetch_alt, item) for item in live_widebodies[:10]]
            for future in as_completed(futures):
                idx, alt = future.result()
                if alt:
                    arrivals[idx]['altitude'] = alt

        # Send response
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'public, max-age=30')
        self.end_headers()
        self.wfile.write(json.dumps({'arrivals': arrivals, 'source': 'flightradar24'}).encode())
