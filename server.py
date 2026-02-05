#!/usr/bin/env python3
"""Simple proxy server for SFO arrivals dashboard."""

import http.server
import json
import urllib.request
import urllib.error
import urllib.parse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

PORT = 8080
BOUNDS = "38.5,36.5,-123.5,-121"

WIDEBODY_TYPES = {
    'A332', 'A333', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346',
    'A359', 'A35K', 'A380', 'A388',
    'B744', 'B748', 'B74S', 'B762', 'B763', 'B764',
    'B772', 'B773', 'B77L', 'B77W', 'B778', 'B779',
    'B788', 'B789', 'B78X', 'MD11',
}

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin': 'https://www.flightradar24.com',
    'Referer': 'https://www.flightradar24.com/',
}

def get_flight_position(flight_id):
    """Fetch live flight position including altitude, lat/lon, heading."""
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
                    return {
                        'alt': latest.get('alt'),
                        'lat': latest.get('lat'),
                        'lon': latest.get('lng'),
                        'heading': latest.get('hd'),
                        'speed': latest.get('spd')
                    }
                elif isinstance(latest, list) and len(latest) >= 5:
                    return {
                        'alt': latest[2],
                        'lat': latest[0],
                        'lon': latest[1],
                        'heading': latest[4] if len(latest) > 4 else None,
                        'speed': latest[3] if len(latest) > 3 else None
                    }
    except:
        pass
    return None


def fetch_flight_details(flight_id):
    """Fetch detailed flight info from FR24 clickhandler."""
    if not flight_id:
        return None
    url = f"https://data-live.flightradar24.com/clickhandler/?flight={flight_id}"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=10) as response:
        data = json.loads(response.read())

    trail = data.get('trail', [])
    aircraft = data.get('aircraft', {})
    identification = data.get('identification', {})
    status = data.get('status', {})
    time_data = data.get('time', {})

    lat, lon, altitude, speed, heading, vspeed = None, None, None, None, None, None
    if trail and len(trail) > 0:
        latest = trail[0]
        if isinstance(latest, dict):
            lat = latest.get('lat')
            lon = latest.get('lng')
            altitude = latest.get('alt')
            speed = latest.get('spd')
            heading = latest.get('hd')
        elif isinstance(latest, list) and len(latest) >= 5:
            lat = latest[0]
            lon = latest[1]
            altitude = latest[2]
            speed = latest[3]
            heading = latest[4]

    if len(trail) >= 2:
        t0 = trail[0]
        t1 = trail[1]
        if isinstance(t0, dict) and isinstance(t1, dict):
            alt0, alt1 = t0.get('alt', 0), t1.get('alt', 0)
            ts0, ts1 = t0.get('ts', 0), t1.get('ts', 0)
            if ts0 > ts1 and (ts0 - ts1) > 0:
                vspeed = int((alt0 - alt1) / ((ts0 - ts1) / 60))

    return {
        'flightId': flight_id,
        'callsign': identification.get('callsign'),
        'registration': aircraft.get('registration'),
        'model': aircraft.get('model', {}).get('text'),
        'modelCode': aircraft.get('model', {}).get('code'),
        'airline': data.get('airline', {}).get('name'),
        'origin': data.get('airport', {}).get('origin', {}).get('name'),
        'originCode': data.get('airport', {}).get('origin', {}).get('code', {}).get('iata'),
        'destination': data.get('airport', {}).get('destination', {}).get('name'),
        'destinationCode': data.get('airport', {}).get('destination', {}).get('code', {}).get('iata'),
        'lat': lat,
        'lon': lon,
        'altitude': altitude,
        'speed': speed,
        'heading': heading,
        'verticalSpeed': vspeed,
        'departureTime': time_data.get('real', {}).get('departure') or time_data.get('scheduled', {}).get('departure'),
        'arrivalTime': time_data.get('estimated', {}).get('arrival') or time_data.get('scheduled', {}).get('arrival'),
        'status': status.get('text'),
        'trail': [[p.get('lat'), p.get('lng'), p.get('alt')] if isinstance(p, dict) else p[:3] for p in trail] if trail else []
    }


AIRPORT_COORDS_WEATHER = {
    'SFO': (37.6213, -122.3790),
    'LAX': (33.9425, -118.4081),
    'JFK': (40.6413, -73.7781),
    'EWR': (40.6895, -74.1745),
    'DFW': (32.8998, -97.0403),
    'SAN': (32.7338, -117.1933),
    'ORD': (41.9742, -87.9073),
    'ATL': (33.6407, -84.4277),
    'SEA': (47.4502, -122.3088),
    'BOS': (42.3656, -71.0096),
    'MIA': (25.7959, -80.2870),
    'DEN': (39.8561, -104.6737),
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/aircraft':
            self.proxy_aircraft()
        elif parsed.path == '/api/schedule':
            query = urllib.parse.parse_qs(parsed.query)
            airport = query.get('airport', ['SFO'])[0]
            self.get_schedule(airport)
        elif parsed.path == '/api/flight-details':
            query = urllib.parse.parse_qs(parsed.query)
            flight_id = query.get('id', [None])[0]
            self.get_flight_details(flight_id)
        elif parsed.path == '/api/weather':
            query = urllib.parse.parse_qs(parsed.query)
            airport = query.get('airport', ['SFO'])[0]
            self.get_weather(airport)
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

    def get_schedule(self, airport='SFO'):
        """Fetch scheduled arrivals from FlightRadar24, including last 12 hours."""
        now = int(time.time())
        all_flights = []
        seen_flights = set()

        # Fetch current + historical data (every 3 hours for last 12 hours)
        timestamps = [now - (i * 3 * 3600) for i in range(5)]  # now, -3h, -6h, -9h, -12h

        for timestamp in timestamps:
            for page in range(1, 3):  # 2 pages per timestamp
                url = f"https://api.flightradar24.com/common/v1/airport.json?code={airport}&plugin=schedule&plugin-setting%5Bschedule%5D%5Bmode%5D=arrivals&plugin-setting%5Bschedule%5D%5Btimestamp%5D={timestamp}&limit=100&page={page}"
                try:
                    req = urllib.request.Request(url, headers=HEADERS)
                    with urllib.request.urlopen(req, timeout=10) as response:
                        data = json.loads(response.read())
                        flights = data.get('result', {}).get('response', {}).get('airport', {}).get('pluginData', {}).get('schedule', {}).get('arrivals', {}).get('data', [])
                        for f in flights:
                            # Dedupe by flight ID
                            fid = f.get('flight', {}).get('identification', {}).get('id')
                            if fid and fid not in seen_flights:
                                seen_flights.add(fid)
                                all_flights.append(f)
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
                'lat': None,
                'lon': None,
                'heading': None,
            }

            arrivals.append(arrival)

        # Prioritize widebody flights for altitude fetch
        live_widebodies = [(i, a['flightId']) for i, a in enumerate(arrivals)
                          if a['live'] and a['flightId'] and a['type'] in WIDEBODY_TYPES]

        # Fetch flight positions in parallel (limit to 15)
        def fetch_pos(item):
            idx, flight_id = item
            return idx, get_flight_position(flight_id)

        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(fetch_pos, item) for item in live_widebodies[:15]]
            for future in as_completed(futures):
                idx, pos = future.result()
                if pos:
                    arrivals[idx]['altitude'] = pos.get('alt')
                    arrivals[idx]['lat'] = pos.get('lat')
                    arrivals[idx]['lon'] = pos.get('lon')
                    arrivals[idx]['heading'] = pos.get('heading')

        self.send_json({'arrivals': arrivals, 'source': 'flightradar24'})

    def get_flight_details(self, flight_id):
        """Get detailed flight info."""
        if not flight_id:
            self.send_error(400, "Missing flight id")
            return
        try:
            details = fetch_flight_details(flight_id)
            self.send_json(details)
        except Exception as e:
            self.send_error(500, str(e))

    def get_weather(self, airport):
        """Get weather for airport."""
        import os
        airport = airport.upper()
        coords = AIRPORT_COORDS_WEATHER.get(airport, AIRPORT_COORDS_WEATHER['SFO'])
        lat, lon = coords

        api_key = os.environ.get('OPENWEATHER_API_KEY', '')

        if not api_key:
            # Return mock/unavailable data
            self.send_json({
                'airport': airport,
                'temp': None,
                'visibility_miles': None,
                'clouds': None,
                'wind_speed': None,
                'wind_direction': None,
                'description': 'Weather unavailable (no API key)',
                'error': 'No API key configured'
            })
            return

        try:
            url = f"https://api.openweathermap.org/data/2.5/weather?lat={lat}&lon={lon}&appid={api_key}&units=imperial"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read())

            wind_deg = data.get('wind', {}).get('deg', 0)
            directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                         'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
            wind_direction = directions[int((wind_deg + 11.25) / 22.5) % 16]

            visibility_m = data.get('visibility', 10000)
            visibility_miles = round(visibility_m / 1609.34, 1)

            result = {
                'airport': airport,
                'temp': round(data.get('main', {}).get('temp', 0)),
                'feels_like': round(data.get('main', {}).get('feels_like', 0)),
                'humidity': data.get('main', {}).get('humidity'),
                'visibility_miles': visibility_miles,
                'clouds': data.get('clouds', {}).get('all', 0),
                'wind_speed': round(data.get('wind', {}).get('speed', 0)),
                'wind_deg': wind_deg,
                'wind_direction': wind_direction,
                'description': data.get('weather', [{}])[0].get('description', '').title(),
                'icon': data.get('weather', [{}])[0].get('icon'),
            }
            self.send_json(result)
        except Exception as e:
            self.send_error(500, str(e))

    def send_json(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

if __name__ == '__main__':
    print(f"Starting Widebody Arrivals server on http://localhost:{PORT}")
    print("Open http://localhost:8080 in your browser")
    http.server.HTTPServer(('', PORT), Handler).serve_forever()
