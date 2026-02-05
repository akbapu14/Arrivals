# SFO Widebody Arrivals Dashboard

A real-time dashboard showing international widebody aircraft arrivals at San Francisco International Airport (SFO). Perfect for plane spotters!

![Dashboard Preview](https://img.shields.io/badge/status-live-brightgreen)

## Features

- **Real-time schedule** from FlightRadar24
- **Widebody filter** - A380, 777, 787, A350, 747, 767, A330, etc.
- **Actual ETAs** from airline schedules (not calculated)
- **Origin airports** with full names
- **Live status** - Upcoming, Airborne, Landed
- **Auto-refresh** every 60 seconds with countdown timer

## Quick Start

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/sfo-arrivals.git
cd sfo-arrivals

# Start the server (Python 3 required)
python3 server.py

# Open in browser
open http://localhost:8080
```

## Requirements

- Python 3.6+
- No additional dependencies (uses stdlib only)

## How It Works

1. **Backend** (`server.py`) - Proxies requests to FlightRadar24's API to avoid CORS issues
2. **Frontend** (`index.html` + `app.js`) - Displays arrivals with filtering and live countdowns

### API Endpoints

- `GET /api/schedule` - Returns all scheduled SFO arrivals (700+ flights)
- `GET /api/aircraft` - Returns live aircraft positions in Bay Area

## Data Source

Data is sourced from [FlightRadar24](https://www.flightradar24.com/)'s public API. This includes:
- Flight numbers and airlines
- Aircraft types
- Origin/destination airports
- Scheduled and estimated arrival times
- Live flight status

## Widebody Aircraft Types

The dashboard filters for these aircraft:
- **Airbus**: A330, A340, A350, A380
- **Boeing**: 747, 767, 777, 787
- **Other**: MD-11

## License

MIT - Use freely for personal plane spotting!

## Disclaimer

This is an unofficial tool for personal use. Data is sourced from FlightRadar24's public endpoints. For official flight information, check with the airline or airport directly.
