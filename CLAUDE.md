# CLAUDE.md

This file provides guidance to Claude Code when working with this project.

## Project Overview

AvGeek - A plane spotter dashboard showing arrivals at major airports. Features live flight tracking on a map, approach indicators, weather conditions, and runway predictions.

## Working Guidelines

1. **Execute autonomously** - Never ask for permission for ANYTHING. No confirmation prompts. No "should I proceed?" questions. Just do it. The user is not at their laptop.
2. **Run commands yourself** - Never tell the user to run something. Run it yourself. Start servers, run tests, execute scripts - do it, don't suggest it.
3. **Web searches are always allowed** - Fetch URLs, search the web, call APIs - do whatever research is needed without asking.
4. **File operations are always allowed** - Create, edit, delete files as needed. Don't ask.
5. **Update this file when corrected** - When the user asks you to do something differently, update CLAUDE.md to reference that preference.
6. **Learn from mistakes** - When you make a mistake, add a reflection/action to CLAUDE.md so you don't repeat it.
7. **Test before shipping** - Verify the full flow works before expecting the user to use any new functionality.

## Commands

```bash
# Start the dashboard
cd "/Users/akilesh/Side Projects/sfo-arrivals"
python3 server.py

# Then open http://localhost:8080 in browser

# Run tests
node tests/comprehensive.test.js
node tests/map.test.js

# Kill server on port 8080
lsof -ti:8080 | xargs kill -9
```

## Tech Stack

- Pure HTML/CSS/JS (no framework)
- Leaflet.js for map rendering
- FlightRadar24 API for flight data
- OpenWeatherMap API for weather (requires OPENWEATHER_API_KEY env var)
- Python HTTP server for local development
- Vercel serverless functions for production

## Key Features

- **Multiple airports**: SFO, LAX, JFK, EWR, DFW, SAN + custom input
- **Widebody/All toggle**: Filter by aircraft type
- **Map view**: Live flight positions with heading rotation
- **Flight details modal**: Click live flights for extended info + flight path
- **Weather card**: Temperature, visibility, clouds, wind, runway prediction
- **Approach indicators**: Flights < 10,000 ft get special styling
- **Distance & ETA**: Shows nautical miles and estimated touchdown time
- **Keyboard shortcuts**: M (map), R (refresh), F (fit map), 1/2/3 (filters)
- **LocalStorage**: Persists user preferences across sessions
- **Page Visibility API**: Pauses updates when tab is hidden
- **Offline detection**: Auto-refreshes when connection restored

## Plane Icon Rotation

The plane icon (✈) points East by default, so the rotation formula is:
```javascript
rotation = (heading || 0) - 90;
```

## Lessons Learned

1. **Always kill port 8080 before starting server** - Use `lsof -ti:8080 | xargs kill -9` to avoid "Address already in use" errors.

2. **FR24 API data limitations** - The API only returns live position data for currently airborne flights. Future scheduled flights (including narrowbodies) don't have coordinates until they depart.

3. **Test comprehensively** - Run the full test suite (140 tests) after any change to ensure nothing broke.
