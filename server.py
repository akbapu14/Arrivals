#!/usr/bin/env python3
"""Optimized proxy server for SFO arrivals dashboard."""

import http.server
import json
import urllib.request
import urllib.error
import urllib.parse
import time
import threading
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

PORT = 8080

# Top airports to pre-warm (US + major international)
TOP_AIRPORTS = ['SFO', 'LAX', 'JFK', 'EWR', 'ORD', 'DFW', 'LHR', 'DXB', 'HND', 'SIN', 'CDG', 'AMS']

# Caches
position_cache = {}  # flight_id -> {data, timestamp}
schedule_cache = {}  # airport -> {arrivals, timestamp}
POSITION_CACHE_TTL = 30  # seconds
SCHEDULE_CACHE_TTL = 45  # seconds

# Background fetcher state
background_running = False
background_thread = None

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


def get_flight_position(flight_id, force_refresh=False):
    """Fetch live flight position with caching."""
    if not flight_id:
        return None

    now = time.time()

    # Check cache first (unless force refresh)
    if not force_refresh and flight_id in position_cache:
        cached = position_cache[flight_id]
        if now - cached['timestamp'] < POSITION_CACHE_TTL:
            return cached['data']

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
                result = None
                if isinstance(latest, dict):
                    result = {
                        'alt': latest.get('alt'),
                        'lat': latest.get('lat'),
                        'lon': latest.get('lng'),
                        'heading': latest.get('hd'),
                        'speed': latest.get('spd'),
                        'live_eta': live_eta
                    }
                elif isinstance(latest, list) and len(latest) >= 5:
                    result = {
                        'alt': latest[2],
                        'lat': latest[0],
                        'lon': latest[1],
                        'heading': latest[4] if len(latest) > 4 else None,
                        'speed': latest[3] if len(latest) > 3 else None,
                        'live_eta': live_eta
                    }
                if result and result.get('lat') and result.get('lon'):
                    position_cache[flight_id] = {'data': result, 'timestamp': now}
                    return result
    except:
        pass

    # Return stale cache if fresh fetch failed
    if flight_id in position_cache:
        return position_cache[flight_id]['data']

    return None


def fetch_schedule_raw(airport, full=True):
    """Fetch raw schedule data from FR24 with parallel requests."""
    now = int(time.time())
    all_flights = []
    seen_flights = set()

    # Build list of URLs to fetch in parallel
    num_timestamps = 5 if full else 2
    num_pages = 3 if full else 2
    urls = []
    for i in range(num_timestamps):
        timestamp = now - (i * 3 * 3600)
        for page in range(1, num_pages):
            url = f"https://api.flightradar24.com/common/v1/airport.json?code={airport}&plugin=schedule&plugin-setting%5Bschedule%5D%5Bmode%5D=arrivals&plugin-setting%5Bschedule%5D%5Btimestamp%5D={timestamp}&limit=100&page={page}"
            urls.append(url)

    def fetch_one(url):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read())
                return data.get('result', {}).get('response', {}).get('airport', {}).get('pluginData', {}).get('schedule', {}).get('arrivals', {}).get('data', [])
        except:
            return []

    # Fetch all URLs in parallel
    with ThreadPoolExecutor(max_workers=10) as executor:
        results = list(executor.map(fetch_one, urls))

    # Combine and dedupe results
    for flights in results:
        for f in flights:
            fid = f.get('flight', {}).get('identification', {}).get('id')
            if fid and fid not in seen_flights:
                seen_flights.add(fid)
                all_flights.append(f)

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
            'registration': aircraft_info.get('registration'),
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

    return arrivals


def enrich_with_positions(arrivals, limit=50):
    """Add position data to arrivals from cache or fetch."""
    now = time.time()

    # Get live flights, prioritize by ETA (soonest first) and widebody
    live_flights = []
    for i, a in enumerate(arrivals):
        if a['live'] and a['flightId']:
            is_widebody = a['type'] in WIDEBODY_TYPES
            eta = a.get('eta') or float('inf')
            live_flights.append((i, a['flightId'], is_widebody, eta))

    # Sort: soonest ETA first, then widebodies
    live_flights.sort(key=lambda x: (x[3], not x[2]))

    # First pass: use cached positions (instant)
    uncached = []
    for i, flight_id, is_wb, eta in live_flights[:limit]:
        if flight_id in position_cache:
            cached = position_cache[flight_id]
            if now - cached['timestamp'] < POSITION_CACHE_TTL * 2:  # Use slightly stale cache
                pos = cached['data']
                arrivals[i]['altitude'] = pos.get('alt')
                arrivals[i]['lat'] = pos.get('lat')
                arrivals[i]['lon'] = pos.get('lon')
                arrivals[i]['heading'] = pos.get('heading')
                # Update ETA with FR24's live tracking estimate
                if pos.get('live_eta'):
                    arrivals[i]['eta'] = pos.get('live_eta')
                continue
        uncached.append((i, flight_id, is_wb, eta))

    # Second pass: fetch uncached positions in parallel
    if uncached:
        def fetch_pos(item):
            idx, flight_id, _, _ = item
            return idx, get_flight_position(flight_id)

        with ThreadPoolExecutor(max_workers=15) as executor:
            futures = [executor.submit(fetch_pos, item) for item in uncached[:30]]
            for future in as_completed(futures):
                try:
                    idx, pos = future.result()
                    if pos:
                        arrivals[idx]['altitude'] = pos.get('alt')
                        arrivals[idx]['lat'] = pos.get('lat')
                        arrivals[idx]['lon'] = pos.get('lon')
                        arrivals[idx]['heading'] = pos.get('heading')
                        # Update ETA with FR24's live tracking estimate
                        if pos.get('live_eta'):
                            arrivals[idx]['eta'] = pos.get('live_eta')
                except:
                    pass

    return arrivals


def background_fetcher():
    """Background thread that pre-warms caches for top airports."""
    global background_running
    print("Background fetcher started")

    # Use a dedicated executor for background work
    executor = ThreadPoolExecutor(max_workers=5)

    while background_running:
        for airport in TOP_AIRPORTS:
            if not background_running:
                break
            try:
                # Fetch schedule using sequential requests (avoids nested executor issues)
                now = int(time.time())
                all_flights = []
                seen_flights = set()

                for i in range(3):  # 3 timestamps
                    timestamp = now - (i * 3 * 3600)
                    for page in range(1, 3):  # 2 pages each
                        url = f"https://api.flightradar24.com/common/v1/airport.json?code={airport}&plugin=schedule&plugin-setting%5Bschedule%5D%5Bmode%5D=arrivals&plugin-setting%5Bschedule%5D%5Btimestamp%5D={timestamp}&limit=100&page={page}"
                        try:
                            req = urllib.request.Request(url, headers=HEADERS)
                            with urllib.request.urlopen(req, timeout=10) as response:
                                data = json.loads(response.read())
                                flights = data.get('result', {}).get('response', {}).get('airport', {}).get('pluginData', {}).get('schedule', {}).get('arrivals', {}).get('data', [])
                                for f in flights:
                                    fid = f.get('flight', {}).get('identification', {}).get('id')
                                    if fid and fid not in seen_flights:
                                        seen_flights.add(fid)
                                        all_flights.append(f)
                        except:
                            pass

                # Parse flights
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

                    arrivals.append({
                        'flight': (ident.get('number') or {}).get('default', ident.get('callsign', '?')),
                        'callsign': ident.get('callsign', '?'),
                        'type': model.get('code', '?'),
                        'typeName': model.get('text', ''),
                        'registration': aircraft_info.get('registration'),
                        'origin': (origin_info.get('code') or {}).get('iata', '?'),
                        'originName': origin_info.get('name', ''),
                        'status': status_info.get('text', ''),
                        'statusColor': status_info.get('icon', ''),
                        'airline': airline_info.get('short', airline_info.get('name', '')),
                        'eta': est.get('arrival') or sched.get('arrival'),
                        'scheduled': sched.get('arrival'),
                        'live': status_info.get('live', False),
                        'flightId': ident.get('id'),
                        'altitude': None, 'lat': None, 'lon': None, 'heading': None,
                    })

                print(f"  {airport}: {len(arrivals)} arrivals")

                # Pre-fetch positions for live flights
                live_flights = [a for a in arrivals if a['live'] and a['flightId']]
                for a in live_flights[:20]:
                    get_flight_position(a['flightId'], force_refresh=True)

                # Update cache
                schedule_cache[airport] = {
                    'arrivals': arrivals,
                    'timestamp': time.time()
                }

            except Exception as e:
                print(f"Background fetch error for {airport}: {e}")

            time.sleep(1)  # Wait between airports

        time.sleep(30)  # Wait before next cycle

    executor.shutdown(wait=False)
    print("Background fetcher stopped")


def start_background_fetcher():
    """Start the background fetcher thread."""
    global background_running, background_thread
    if not background_running:
        background_running = True
        background_thread = threading.Thread(target=background_fetcher, daemon=True)
        background_thread.start()


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


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == '/api/schedule':
            query = urllib.parse.parse_qs(parsed.query)
            airport = query.get('airport', ['SFO'])[0].upper()
            fast = query.get('fast', ['0'])[0] == '1'
            self.get_schedule(airport, fast)
        elif parsed.path == '/api/positions':
            query = urllib.parse.parse_qs(parsed.query)
            flight_ids = query.get('ids', [''])[0].split(',')
            self.get_positions(flight_ids)
        elif parsed.path == '/api/flight-details':
            query = urllib.parse.parse_qs(parsed.query)
            flight_id = query.get('id', [None])[0]
            self.get_flight_details(flight_id)
        elif parsed.path == '/api/weather':
            query = urllib.parse.parse_qs(parsed.query)
            airport = query.get('airport', ['SFO'])[0]
            self.get_weather(airport)
        elif parsed.path == '/api/stream':
            query = urllib.parse.parse_qs(parsed.query)
            airport = query.get('airport', ['SFO'])[0].upper()
            self.stream_updates(airport)
        elif parsed.path == '/api/aircraft-photo':
            query = urllib.parse.parse_qs(parsed.query)
            registration = query.get('reg', [None])[0]
            self.get_aircraft_photo(registration)
        else:
            super().do_GET()

    def get_schedule(self, airport='SFO', fast=False):
        """Get schedule - uses cache if available, fetches fresh if not."""
        now = time.time()

        # Check cache first
        if airport in schedule_cache:
            cached = schedule_cache[airport]
            cache_age = now - cached['timestamp']

            # For fast mode or fresh cache, return cached data
            if fast or cache_age < SCHEDULE_CACHE_TTL:
                arrivals = cached['arrivals'].copy()
                # Enrich with latest positions from cache
                arrivals = enrich_with_positions(arrivals, limit=50)
                self.send_json({
                    'arrivals': arrivals,
                    'source': 'flightradar24',
                    'cached': True,
                    'cache_age': round(cache_age, 1)
                })
                return

        # Fetch fresh schedule (quick mode for faster response)
        arrivals = fetch_schedule_raw(airport, full=False)

        # Update cache
        schedule_cache[airport] = {
            'arrivals': arrivals,
            'timestamp': now
        }

        # Enrich with positions (fewer for cold fetch - just top 15)
        arrivals = enrich_with_positions(arrivals, limit=15)

        self.send_json({
            'arrivals': arrivals,
            'source': 'flightradar24',
            'cached': False
        })

    def get_positions(self, flight_ids):
        """Get positions for specific flight IDs."""
        positions = {}
        for fid in flight_ids:
            if fid:
                pos = get_flight_position(fid)
                if pos:
                    positions[fid] = pos
        self.send_json({'positions': positions})

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
        airport = airport.upper()
        coords = AIRPORT_COORDS_WEATHER.get(airport, AIRPORT_COORDS_WEATHER['SFO'])
        lat, lon = coords

        api_key = os.environ.get('OPENWEATHER_API_KEY', '')

        if not api_key:
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

    def get_aircraft_photo(self, registration):
        """Get aircraft photo from Planespotters.net."""
        if not registration:
            self.send_json({'url': None, 'error': 'Missing registration'})
            return

        try:
            url = f"https://api.planespotters.net/pub/photos/reg/{registration}"
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read())

            photo_url = None
            if data.get('photos') and len(data['photos']) > 0:
                photo = data['photos'][0]
                if photo.get('thumbnail_large'):
                    photo_url = photo['thumbnail_large'].get('src')

            self.send_json({'url': photo_url})
        except Exception as e:
            self.send_json({'url': None, 'error': str(e)})

    def stream_updates(self, airport):
        """SSE endpoint for real-time updates."""
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()

        try:
            last_update = 0
            while True:
                now = time.time()

                # Send update every 15 seconds
                if now - last_update >= 15:
                    if airport in schedule_cache:
                        cached = schedule_cache[airport]
                        arrivals = cached['arrivals'].copy()
                        arrivals = enrich_with_positions(arrivals, limit=50)

                        data = json.dumps({
                            'arrivals': arrivals,
                            'timestamp': now
                        })
                        self.wfile.write(f"data: {data}\n\n".encode())
                        self.wfile.flush()
                    last_update = now

                time.sleep(1)
        except:
            pass  # Client disconnected

    def send_json(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'public, max-age=5')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())


if __name__ == '__main__':
    # Start background fetcher
    start_background_fetcher()

    print(f"Starting Optimized Arrivals server on http://localhost:{PORT}")
    print(f"Background pre-warming: {', '.join(TOP_AIRPORTS)}")
    print("Open http://localhost:8080 in your browser")

    http.server.HTTPServer(('', PORT), Handler).serve_forever()
