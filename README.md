# HELM — Maritime Crisis Operations

HELM is a real-time command system for the 15 ships supplied in `server/fleet.json`. It provides Command and ship-scoped Captain dashboards, continuous simulation, restricted-zone controls, alerts, weather-aware fuel consumption, route updates, and one-hour playback.

## Run

```bash
docker compose up --build
```

Open `http://localhost:5173`. Command is the default role; choose Captain and a vessel to demonstrate captain-scoped directives. PostgreSQL is exposed on 5432 and the API on 3001. Copy `.env.example` to `.env` to customize the defaults.

## Architecture

The React/TypeScript client receives authoritative `fleet:state` Socket.IO events from the Node/TypeScript backend. The in-memory `FleetEngine` ticks at `SIMULATION_TICK_MS` (1 second by default); PostgreSQL is deliberately outside the tick path. The backend persists zones, alerts, directives/events, and 30-second ship snapshots to PostgreSQL/PostGIS.

```
React + Leaflet ── Socket.IO ── FleetEngine / AlertEngine / Routing ── PostgreSQL + PostGIS
```

`backend/src/schema.ts` defines ships, restricted_zones, ship_routes, directives, alerts, distress_events, ship_snapshots, weather_snapshots, and system_events. Zone geometry uses a PostGIS GIST index; alerts and snapshots have operational indexes.

## Behavior

- Exactly 15 ships load from the supplied `fleet.json`; the backend owns their position, heading, route, fuel, weather, and status.
- Every tick moves ships, applies the 1.30 adverse-weather fuel multiplier, checks arrival/fuel/zone/proximity conditions, saves snapshots, and broadcasts state.
- Command-only Socket.IO events create, update, and delete zones and issue directives. Captains are validated server-side against one assigned ship before responding.
- New zones trigger geofence events for ships already inside and recalculate intersecting routes. Proximity alerts activate at 2 km and resolve after 2.25 km.
- `WeatherService` caches Open-Meteo conditions and has a visibly marked deterministic fallback for offline judging.
- Distress messages use deterministic structured extraction without an AI key, producing severity, issue, injuries, cargo damage, and assistance need. An external model can be placed behind that validated result boundary.
- The glass command center has browser-audio high/critical alerts after user interaction, status-coloured ship markers, route display, command cards, alert acknowledgement, and a playback scrubber.

## Environment

See `.env.example`. `DATABASE_URL`, `OPEN_METEO_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `SIMULATION_TICK_MS`, `PORT`, and `CLIENT_URL` are configurable. AI is optional and its credentials never reach the browser.

## Tests

```bash
cd backend
npm install
npm test -- --cache=false
npx tsc --noEmit
```

The engine tests verify the 15-vessel source, immediate geofence handling, and directive acceptance.

## Assumptions

The supplied operational-water polygon and some supplied destination ports do not fully align. HELM treats each supplied port as the terminal target and marks a vessel that begins outside navigable water as stranded. Its route planner uses safe segment detours around active restricted polygons and is structured for replacement with a denser A* water grid if tighter coastline behavior is needed. OpenStreetMap tiles need internet access; weather has the documented local fallback.
