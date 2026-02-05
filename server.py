#!/usr/bin/env python3
"""Simple proxy server for SFO arrivals dashboard."""

import http.server
import json
import urllib.request
import urllib.error
import time

PORT = 8080
BOUNDS = "38.5,36.5,-123.5,-121"

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin': 'https://www.flightradar24.com',
    'Referer': 'https://www.flightradar24.com/',
}

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/aircraft':
            self.proxy_aircraft()
        elif self.path == '/api/schedule':
            self.get_schedule()
        else:
            super().do_GET()

    def proxy_aircraft(self):
        """Fetch live aircraft from FlightRadar24."""
        url = f"https://data-cloud.flightradar24.com/zones/fcgi/feed.js?faa=1&bounds={BOUNDS}&satellite=1&mlat=1&flarm=1&adsb=1&gnd=0&air=1&vehicles=0&estimated=1&maxage=14400&gliders=0&stats=0"

        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=10) as response:
                raw = json.loads(response.read())

            aircraft = []
            for fid, data in raw.items():
                if not isinstance(data, list) or len(data) < 17:
                    continue
                aircraft.append({
                    'id': fid,
                    'lat': data[1],
                    'lon': data[2],
                    'track': data[3],
                    'altitude': data[4],
                    'speed': data[5],
                    'type': data[8],
                    'registration': data[9],
                    'origin': data[11],
                    'destination': data[12],
                    'flight': data[13],
                    'onGround': data[14],
                    'vspeed': data[15],
                    'callsign': data[16] if len(data) > 16 else data[13],
                })

            self.send_json({'aircraft': aircraft, 'source': 'flightradar24'})
        except Exception as e:
            self.send_error(500, str(e))

    def get_schedule(self):
        """Fetch scheduled SFO arrivals from FlightRadar24."""
        timestamp = int(time.time())
        all_flights = []

        # Fetch multiple pages
        for page in range(1, 9):
            url = f"https://api.flightradar24.com/common/v1/airport.json?code=SFO&plugin=schedule&plugin-setting%5Bschedule%5D%5Bmode%5D=arrivals&plugin-setting%5Bschedule%5D%5Btimestamp%5D={timestamp}&limit=100&page={page}"
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
            airport = f.get('airport') or {}
            origin_info = airport.get('origin') or {}
            status_info = f.get('status') or {}
            airline_info = f.get('airline') or {}
            time_data = f.get('time') or {}
            est = time_data.get('estimated') or {}
            sched = time_data.get('scheduled') or {}

            arrivals.append({
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
            })

        self.send_json({'arrivals': arrivals, 'source': 'flightradar24'})

    def send_json(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

if __name__ == '__main__':
    print(f"Starting SFO Arrivals server on http://localhost:{PORT}")
    print("Open http://localhost:8080 in your browser")
    http.server.HTTPServer(('', PORT), Handler).serve_forever()
