"""Vercel serverless function for aircraft photos from Planespotters.net."""

from http.server import BaseHTTPRequestHandler
import json
import urllib.request
import urllib.parse


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        registration = query.get('reg', [None])[0]

        if not registration:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Missing registration parameter'}).encode())
            return

        try:
            url = f"https://api.planespotters.net/pub/photos/reg/{registration}"
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            })
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read())

            # Extract thumbnail URL
            photo_url = None
            if data.get('photos') and len(data['photos']) > 0:
                photo = data['photos'][0]
                if photo.get('thumbnail_large'):
                    photo_url = photo['thumbnail_large'].get('src')

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=86400')  # Cache for 24 hours
            self.end_headers()
            self.wfile.write(json.dumps({'url': photo_url}).encode())

        except Exception as e:
            self.send_response(200)  # Return 200 with null to avoid breaking the UI
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'url': None, 'error': str(e)}).encode())
