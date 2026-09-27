# HELM — Maritime Crisis Operations

HELM is a real-time fleet command simulator for the Code Rush Strait of Hormuz scenario. It loads the supplied 15-vessel fleet, gives Command and ship-scoped Captain views, and streams simulated vessel state over Socket.IO.

## Run with Docker

```bash
docker compose up --build
```

Open <http://localhost:5173>. The frontend, Node backend, and PostgreSQL/PostGIS database start together. Copy `.env.example` to `.env` to override defaults.

## Run locally

The backend requires PostgreSQL with PostGIS enabled. Create a database named `helm`, install PostGIS for that PostgreSQL version, then use two terminals:

```powershell
# Terminal 1 — backend
cd backend
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/helm"
npm run dev
```

```powershell
# Terminal 2 — frontend
cd frontend
npm run dev
```

Open <http://localhost:5173>. Replace `YOUR_PASSWORD` with the password for your local PostgreSQL user.

## Supplied fleet data and assumptions

`server/fleet.json` preserves the original Code Rush fleet file: scenario metadata, its bounding box and navigable-water polygon, ten ports, and all 15 named vessels. `backend/src/fleet.ts` adapts it to the simulation model:

- The supplied coordinates are `[lat, lng]`; routing geometry is converted to GeoJSON `[lng, lat]`. The source water ring pinches shut at the Strait of Hormuz, so routing adds a narrow connector polygon (56.30–56.65°E, 26.30–26.48°N) between its Gulf and Gulf of Oman sections. This repairs the simplified operational boundary; it is not a restricted zone.
- Source speeds are knots; the simulator uses km/h internally and the UI displays knots.
- Source fuel is in tons. The assignment does not provide tank capacities, so the demo assumes a 10,000-ton full tank for percentage and range estimates.
- Port destinations are resolved by ID. Routes terminate at the nearest navigable-water approach point instead of plotting the vessel onto an inland port coordinate.

The provided water polygon is a simplified operational boundary, not a detailed coastline chart. Route segments are checked against that polygon and active restricted zones, but the simulator cannot guarantee a ship stays clear of every real-world shoreline feature outside the supplied geometry.

## Behavior

- Exactly 15 source vessels are loaded. The authoritative simulation ticks at 1 Hz by default and broadcasts state to all connected clients.
- Movement is interpolated in the browser between server updates. Ship list and map selection focus the map on the chosen vessel; hovering shows vessel telemetry and live coordinates.
- Command can draw restricted zones and select an existing zone to edit or delete it. Captain sessions receive only their assigned ship, its alerts and history, and can respond only for that ship. Optional per-ship access codes and a Command access code are enforced server-side when configured.
- Geofence alerts are checked each tick, and drawing a zone around a ship already inside it produces an immediate alert. Alerts remain active until acknowledged; acknowledgements leave the active-alert list.
- Proximity warnings activate below 2 km and resolve above 2.25 km.
- Adverse wind applies a 30% fuel penalty. Open-Meteo forecasts are fetched in a batched request for fleet and destination locations; a marked deterministic fallback is used offline. Route cost and fuel reachability estimates use the current spatial samples.
- Captain distress text is sent to OpenAI when `AI_API_KEY` is configured and validated against a structured schema. Distress alerts display extracted issue, injuries, damage, and whether OpenAI or the deterministic fallback produced the result. If no key is configured or the request fails, the fallback reason is recorded in alert metadata.
- PostgreSQL/PostGIS persists zones, routes, directives, alerts, weather samples, events, and 30-second ship snapshots. The playback slider groups those snapshots into times for the last-hour timeline.
- The map offers 2D and perspective-tilt modes. The 3D option is a tilted view of the 2D basemap, not a globe or terrain rendering.

## Environment

See `.env.example` for `DATABASE_URL`, `OPEN_METEO_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `SIMULATION_TICK_MS`, `PORT`, `CLIENT_URL`, and optional `COMMAND_ACCESS_CODE` / `CAPTAIN_ACCESS_CODES`. Captain codes map ship IDs to codes, such as `MV-1=code1,MV-2=code2`; when configured, each Captain is limited to the ship whose code they provide. With no access codes configured, role switching stays open for local demo use. AI is optional; its key is used only by the backend. To use Groq instead of OpenAI, set `AI_BASE_URL=https://api.groq.com/openai/v1`, `AI_MODEL=openai/gpt-oss-20b`, and `AI_API_KEY` to your Groq key. A local `backend/.env` file is ignored by Git; never put provider keys in frontend code.

## Tests

```bash
cd backend
npm test -- --cache=false
npx tsc --noEmit
```
