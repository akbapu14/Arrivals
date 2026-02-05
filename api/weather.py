"""Vercel serverless function for airport weather."""

from http.server import BaseHTTPRequestHandler
import json
import urllib.request
import urllib.parse
import os

# Airport coordinates for weather lookup
AIRPORT_COORDS = {
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


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        airport = query.get('airport', ['SFO'])[0].upper()

        # Get airport coordinates
        coords = AIRPORT_COORDS.get(airport)
        if not coords:
            # Default to SFO if unknown airport
            coords = AIRPORT_COORDS['SFO']

        lat, lon = coords

        # Get API key from environment
        api_key = os.environ.get('OPENWEATHER_API_KEY', '')

        if not api_key:
            # Return mock data if no API key
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=300')
            self.end_headers()
            self.wfile.write(json.dumps({
                'airport': airport,
                'temp': None,
                'feels_like': None,
                'humidity': None,
                'visibility': None,
                'visibility_miles': None,
                'clouds': None,
                'wind_speed': None,
                'wind_deg': None,
                'wind_direction': None,
                'description': 'Weather data unavailable',
                'icon': None,
                'error': 'No API key configured'
            }).encode())
            return

        try:
            url = f"https://api.openweathermap.org/data/2.5/weather?lat={lat}&lon={lon}&appid={api_key}&units=imperial"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read())

            # Parse wind direction
            wind_deg = data.get('wind', {}).get('deg', 0)
            directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                         'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
            wind_direction = directions[int((wind_deg + 11.25) / 22.5) % 16]

            # Convert visibility from meters to miles
            visibility_m = data.get('visibility', 10000)
            visibility_miles = round(visibility_m / 1609.34, 1)

            result = {
                'airport': airport,
                'temp': round(data.get('main', {}).get('temp', 0)),
                'feels_like': round(data.get('main', {}).get('feels_like', 0)),
                'humidity': data.get('main', {}).get('humidity'),
                'visibility': visibility_m,
                'visibility_miles': visibility_miles,
                'clouds': data.get('clouds', {}).get('all', 0),
                'wind_speed': round(data.get('wind', {}).get('speed', 0)),
                'wind_deg': wind_deg,
                'wind_direction': wind_direction,
                'description': data.get('weather', [{}])[0].get('description', '').title(),
                'icon': data.get('weather', [{}])[0].get('icon'),
            }

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=300')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
