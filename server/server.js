const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const fleetData = require('./fleet-adapter.cjs')(require('./fleet.json'));
const { WeatherService } = require('./weather');
const { Simulation, TICK_HZ } = require('./simulation');

const PORT = process.env.PORT || 8080;
// Speeds up simulated time for demo/grading purposes (real ships are slow).
// 1 = real-time. Documented in README.
const TIME_MULTIPLIER = parseFloat(process.env.SIM_TIME_MULTIPLIER || '40');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = app.listen(PORT, () => {
  console.log(`Fleet Command server listening on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

const weather = new WeatherService(fleetData.bbox);
const sim = new Simulation(fleetData, weather, { timeMultiplier: TIME_MULTIPLIER });

// ---- broadcast helpers ----
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

sim.on('update', (snapshot) => broadcast({ kind: 'state', snapshot }));
sim.on('alert', (alert) => broadcast({ kind: 'alert', alert }));

// ---- static config / history REST endpoints ----
app.get('/api/config', (req, res) => {
  res.json({ bbox: fleetData.bbox, navigablePolygon: fleetData.navigablePolygon, tickHz: TICK_HZ });
});
app.get('/api/history', (req, res) => {
  res.json({ history: sim.history });
});
app.get('/api/state', (req, res) => {
  res.json(sim.snapshot());
});

// ---- websocket protocol ----
// Client -> Server messages:
//   {type:'hello', role:'command'|'captain', shipId?}
//   {type:'draw_zone', polygon:[{lat,lng},...], label}
//   {type:'remove_zone', zoneId}
//   {type:'issue_directive', shipId, directive:{type, payload}}
//   {type:'respond_directive', shipId, response:'ACCEPT'|'ESCALATE_DISTRESS', payload}
//   {type:'ack_alert', alertId}
//
// Server -> Client messages:
//   {kind:'state', snapshot}
//   {kind:'alert', alert}
//   {kind:'ack', for, ok, error?}

wss.on('connection', (ws) => {
  ws.role = null;
  ws.shipId = null;

  ws.send(JSON.stringify({ kind: 'state', snapshot: sim.snapshot() }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    try {
      switch (msg.type) {
        case 'hello': {
          ws.role = msg.role === 'captain' ? 'captain' : 'command';
          ws.shipId = msg.shipId || null;
          ws.send(JSON.stringify({ kind: 'ack', for: 'hello', ok: true }));
          break;
        }
        case 'draw_zone': {
          if (ws.role !== 'command') throw new Error('Only Command can draw zones');
          const zone = sim.addZone(msg.polygon, msg.label);
          broadcast({ kind: 'state', snapshot: sim.snapshot() });
          ws.send(JSON.stringify({ kind: 'ack', for: 'draw_zone', ok: true, zone }));
          break;
        }
        case 'remove_zone': {
          if (ws.role !== 'command') throw new Error('Only Command can remove zones');
          sim.removeZone(msg.zoneId);
          broadcast({ kind: 'state', snapshot: sim.snapshot() });
          break;
        }
        case 'issue_directive': {
          if (ws.role !== 'command') throw new Error('Only Command can issue directives');
          const directive = sim.issueDirective(msg.shipId, msg.directive);
          broadcast({ kind: 'state', snapshot: sim.snapshot() });
          ws.send(JSON.stringify({ kind: 'ack', for: 'issue_directive', ok: true, directive }));
          break;
        }
        case 'respond_directive': {
          if (ws.role !== 'captain' || ws.shipId !== msg.shipId) {
            throw new Error('Only the ship\'s own captain can respond');
          }
          const result = await sim.respondDirective(msg.shipId, msg.response, msg.payload || {});
          broadcast({ kind: 'state', snapshot: sim.snapshot() });
          broadcast({ kind: 'directive_response', shipId: msg.shipId, result });
          break;
        }
        case 'ack_alert': {
          sim.acknowledgeAlert(msg.alertId);
          broadcast({ kind: 'state', snapshot: sim.snapshot() });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ kind: 'ack', for: msg.type, ok: false, error: err.message }));
    }
  });
});

// ---- tick loop ----
weather.start().then(() => {
  console.log(`Weather service started (fallback mode: ${weather.usingFallback})`);
});
setInterval(() => sim.tick(), (1000 / TICK_HZ));

process.on('SIGTERM', () => {
  weather.stop();
  server.close(() => process.exit(0));
});
