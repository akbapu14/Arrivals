# CLAUDE.md

This file provides guidance to Claude Code when working with this project.

## Project Overview

A simple dashboard to view international widebody aircraft arrivals at SFO airport, designed for plane spotting. Shows actual landing times (not gate arrivals).

## Working Guidelines

1. **Execute autonomously** - Never ask for permission for ANYTHING. No confirmation prompts. No "should I proceed?" questions. Just do it. The user is not at their laptop.
2. **Web searches are always allowed** - Fetch URLs, search the web, call APIs - do whatever research is needed without asking.
3. **File operations are always allowed** - Create, edit, delete files as needed. Don't ask.
4. **Update this file when corrected** - When the user asks you to do something differently, update CLAUDE.md to reference that preference.
5. **Learn from mistakes** - When you make a mistake, add a reflection/action to CLAUDE.md so you don't repeat it.
6. **Test before shipping** - Verify the full flow works before expecting the user to use any new functionality.

## Commands

```bash
# Start the dashboard
cd "/Users/akilesh/Side Projects/sfo-arrivals"
python3 server.py

# Then open http://localhost:8080 in browser
```

## Tech Stack

- Pure HTML/CSS/JS (no framework)
- OpenSky Network API (free, no auth required)
- Auto-refreshes every 30 seconds

## Lessons Learned

(None yet)
