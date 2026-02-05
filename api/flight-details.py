"""Vercel serverless function for flight details."""

from http.server import BaseHTTPRequestHandler
import json
import urllib.request
import urllib.parse

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin': 'https://www.flightradar24.com',
    'Referer': 'https://www.flightradar24.com/',
}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        flight_id = query.get('id', [None])[0]

        if not flight_id:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Missing flight id'}).encode())
            return

        try:
            url = f"https://data-live.flightradar24.com/clickhandler/?flight={flight_id}"
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read())

            # Extract relevant details
            trail = data.get('trail', [])
            aircraft = data.get('aircraft', {})
            identification = data.get('identification', {})
            status = data.get('status', {})
            time_data = data.get('time', {})

            # Get current position from trail
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

            # Get vertical speed from status or estimate from trail
            if len(trail) >= 2:
                t0 = trail[0]
                t1 = trail[1]
                if isinstance(t0, dict) and isinstance(t1, dict):
                    alt0, alt1 = t0.get('alt', 0), t1.get('alt', 0)
                    ts0, ts1 = t0.get('ts', 0), t1.get('ts', 0)
                    if ts0 > ts1 and (ts0 - ts1) > 0:
                        vspeed = int((alt0 - alt1) / ((ts0 - ts1) / 60))  # ft/min

            result = {
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
                'trail': [[p.get('lat'), p.get('lng'), p.get('alt')] if isinstance(p, dict) else p[:3] for p in trail[:50]] if trail else []
            }

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=10')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
