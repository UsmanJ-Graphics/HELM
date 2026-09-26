// simulation.js — the authoritative fleet state and tick loop.
// Single source of truth: every connected client (Command or any Captain)
// just renders whatever this class broadcasts. No client-side state forking.

const { haversineKm, bearing, pointInPolygon } = require('./geo');
const { computeRoute } = require('./routing');
const { extractDistressInfo } = require('./nlp');

const TICK_HZ = 1; // >= 1Hz per spec
const PROXIMITY_KM = 2;
const FULL_TANK_RANGE_KM = 3200; // assumption: 100% fuel = 3200km range at cruise speed
const HISTORY_INTERVAL_MS = 30 * 1000; // 30s resolution
const HISTORY_MAX_SNAPSHOTS = 120; // 1 hour at 30s resolution

let idCounter = 1;
const nextId = (prefix) => `${prefix}-${idCounter++}-${Date.now().toString(36)}`;

class Simulation {
  constructor(fleetData, weatherService, { timeMultiplier = 1 } = {}) {
    this.bbox = fleetData.bbox;
    this.navigablePolygon = fleetData.navigablePolygon;
    this.weather = weatherService;
    this.timeMultiplier = timeMultiplier;

    this.ships = fleetData.ships.map((s) => ({
      ...s,
      route: [],
      routeTarget: 0,
      feasible: true,
      pendingDirective: null,
      lastDirectiveResponse: null,
    }));

    this.zones = []; // {id, polygon:[[lng,lat],...], label, createdAt}
    this.alerts = []; // {id, type, severity, shipId, message, createdAt, acknowledged, resolvedAt, data}
    this.history = []; // ring buffer of snapshots
    this._lastHistoryPush = 0;

    this.ships.forEach((s) => this._recomputeRoute(s));

    this._listeners = { update: [], alert: [] };
  }

  on(event, cb) {
    this._listeners[event]?.push(cb);
  }
  _emit(event, payload) {
    (this._listeners[event] || []).forEach((cb) => cb(payload));
  }

  // ---------- alerts ----------
  _raiseAlert({ type, severity, shipId, message, data = {} }) {
    const alert = {
      id: nextId('alert'),
      type,
      severity,
      shipId,
      message,
      data,
      createdAt: Date.now(),
      acknowledged: false,
      resolvedAt: null,
    };
    this.alerts.unshift(alert);
    this.alerts = this.alerts.slice(0, 200); // cap history
    this._emit('alert', alert);
    return alert;
  }

  acknowledgeAlert(alertId) {
    const a = this.alerts.find((x) => x.id === alertId);
    if (a) a.acknowledged = true;
    return a;
  }

  resolveAlert(alertId) {
    const a = this.alerts.find((x) => x.id === alertId);
    if (a) a.resolvedAt = Date.now();
    return a;
  }

  // ---------- zones ----------
  addZone(polygonLatLng, label, createdBy = 'command') {
    // polygonLatLng: [{lat,lng}, ...] from the UI -> store as [lng,lat] pairs
    const polygon = polygonLatLng.map((p) => [p.lng, p.lat]);
    const zone = { id: nextId('zone'), polygon, label: label || 'Restricted Zone', createdAt: Date.now(), createdBy };
    this.zones.push(zone);

    // Any ship already inside -> immediate breach alert.
    this.ships.forEach((ship) => {
      if (pointInPolygon(ship, polygon)) {
        this._raiseAlert({
          type: 'geofence-breach',
          severity: 'high',
          shipId: ship.id,
          message: `${ship.name} is inside newly drawn zone "${zone.label}"`,
        });
      }
    });

    // Any ship whose current route crosses the new zone -> reroute.
    this.ships.forEach((ship) => {
      if (this._routeCrosses(ship, [zone])) {
        ship.status = 'rerouting';
        this._recomputeRoute(ship);
      }
    });

    return zone;
  }

  removeZone(zoneId) {
    this.zones = this.zones.filter((z) => z.id !== zoneId);
    this.ships.forEach((ship) => this._recomputeRoute(ship));
  }

  _routeCrosses(ship, zonesToCheck) {
    const route = ship.route.length ? ship.route : [ship, ship.destination];
    for (let i = 0; i < route.length - 1; i++) {
      for (const z of zonesToCheck) {
        const { boundingCircle, segmentIntersectsCircle } = require('./geo');
        if (segmentIntersectsCircle(route[i], route[i + 1], boundingCircle(z.polygon))) return true;
      }
    }
    return false;
  }

  // ---------- routing ----------
  _recomputeRoute(ship) {
    const storms = this.weather ? this.weather.stormCells() : [];
    const { path, feasible } = computeRoute(
      { lat: ship.lat, lng: ship.lng },
      { lat: ship.destination.lat, lng: ship.destination.lng },
      this.zones,
      storms
    );
    ship.route = path;
    ship.routeTarget = 1; // index 0 is current position
    ship.feasible = feasible;
    if (!feasible) {
      ship.status = 'stranded';
      this._raiseAlert({
        type: 'stranded',
        severity: 'critical',
        shipId: ship.id,
        message: `${ship.name} has no valid path to ${ship.destination.name} — boxed in by restricted zones`,
      });
    } else if (ship.status === 'stranded') {
      ship.status = 'rerouting';
    }
  }

  // ---------- directives (Command -> Captain) ----------
  issueDirective(shipId, directive) {
    const ship = this.ships.find((s) => s.id === shipId);
    if (!ship) return null;
    ship.pendingDirective = {
      id: nextId('dir'),
      type: directive.type, // 'reroute' | 'divert-waypoint' | 'hold'
      payload: directive.payload || {},
      createdAt: Date.now(),
      status: 'pending',
    };
    return ship.pendingDirective;
  }

  async respondDirective(shipId, response, payload = {}) {
    const ship = this.ships.find((s) => s.id === shipId);
    if (!ship || !ship.pendingDirective) return null;

    const directive = ship.pendingDirective;

    if (response === 'ACCEPT') {
      directive.status = 'accepted';
      if (directive.type === 'reroute' && payload.destination) {
        ship.destination = payload.destination;
      } else if (directive.type === 'divert-waypoint' && payload.waypoint) {
        ship.destination = payload.waypoint;
      } else if (directive.type === 'hold') {
        ship.status = 'stopped';
      }
      if (directive.type !== 'hold') {
        ship.status = 'rerouting';
        this._recomputeRoute(ship);
      }
      ship.lastDirectiveResponse = { response, at: Date.now() };
      ship.pendingDirective = null;
      return { response, ship };
    }

    if (response === 'ESCALATE_DISTRESS') {
      directive.status = 'escalated';
      const info = await extractDistressInfo(payload.message || '');
      ship.status = 'distressed';
      const alert = this._raiseAlert({
        type: 'distress',
        severity: info.severity === 'critical' ? 'critical' : info.severity === 'high' ? 'high' : 'medium',
        shipId: ship.id,
        message: `${ship.name} distress: ${info.summary}`,
        data: info,
      });
      ship.lastDirectiveResponse = { response, at: Date.now(), distressInfo: info };
      ship.pendingDirective = null;
      return { response, ship, alert, distressInfo: info };
    }

    return null;
  }

  // ---------- proximity ----------
  _checkProximity() {
    for (let i = 0; i < this.ships.length; i++) {
      for (let j = i + 1; j < this.ships.length; j++) {
        const a = this.ships[i], b = this.ships[j];
        const d = haversineKm(a, b);
        if (d <= PROXIMITY_KM) {
          const already = this.alerts.find(
            (al) => al.type === 'proximity' && !al.resolvedAt &&
              ((al.data.a === a.id && al.data.b === b.id) || (al.data.a === b.id && al.data.b === a.id))
          );
          if (!already) {
            this._raiseAlert({
              type: 'proximity',
              severity: 'medium',
              shipId: a.id,
              message: `${a.name} and ${b.name} are within ${d.toFixed(2)}km of each other`,
              data: { a: a.id, b: b.id, distanceKm: d },
            });
          }
        } else {
          const active = this.alerts.find(
            (al) => al.type === 'proximity' && !al.resolvedAt &&
              ((al.data.a === a.id && al.data.b === b.id) || (al.data.a === b.id && al.data.b === a.id))
          );
          if (active) active.resolvedAt = Date.now();
        }
      }
    }
  }

  // ---------- tick ----------
  tick() {
    const dtSeconds = (1 / TICK_HZ) * this.timeMultiplier;
    const dtHours = dtSeconds / 3600;

    this.ships.forEach((ship) => {
      if (ship.status === 'stopped' || ship.status === 'stranded' || ship.fuel <= 0) {
        if (ship.fuel <= 0 && ship.status !== 'out-of-fuel') {
          ship.status = 'out-of-fuel';
          this._raiseAlert({
            type: 'out-of-fuel',
            severity: 'critical',
            shipId: ship.id,
            message: `${ship.name} has run out of fuel`,
          });
        }
        return;
      }

      // Arrived?
      const distToDest = haversineKm(ship, ship.destination);
      if (distToDest < 1 && ship.status !== 'arrived') {
        ship.status = 'arrived';
        this._raiseAlert({
          type: 'arrived',
          severity: 'low',
          shipId: ship.id,
          message: `${ship.name} has arrived at ${ship.destination.name}`,
        });
        return;
      }
      if (ship.status === 'arrived') return;

      // Move along route.
      let remainingKm = ship.speed * dtHours;
      let target = ship.route[ship.routeTarget] || ship.destination;

      while (remainingKm > 0) {
        const distToTarget = haversineKm(ship, target);
        if (distToTarget <= remainingKm) {
          ship.lat = target.lat;
          ship.lng = target.lng;
          remainingKm -= distToTarget;
          ship.routeTarget += 1;
          if (ship.routeTarget >= ship.route.length) {
            target = ship.destination;
            break;
          }
          target = ship.route[ship.routeTarget];
        } else {
          const brng = bearing(ship, target);
          const { destinationPoint } = require('./geo');
          const moved = destinationPoint(ship, brng, remainingKm);
          ship.lat = moved.lat;
          ship.lng = moved.lng;
          ship.heading = brng;
          remainingKm = 0;
        }
      }

      // Weather + fuel.
      const conditions = this.weather ? this.weather.conditionsAt(ship.lat, ship.lng) : { adverse: false };
      const distMovedKm = ship.speed * dtHours;
      const fuelBurnPct = (distMovedKm / FULL_TANK_RANGE_KM) * 100 * (conditions.adverse ? 1.3 : 1);
      ship.fuel = Math.max(0, ship.fuel - fuelBurnPct);
      ship.inAdverseWeather = !!conditions.adverse;

      // Insufficient-fuel projection: can it finish the remaining route?
      const remainingRouteKm = this._remainingRouteKm(ship);
      const rangeLeftKm = (ship.fuel / 100) * FULL_TANK_RANGE_KM;
      if (rangeLeftKm < remainingRouteKm && ship.status !== 'insufficient-fuel' && ship.fuel > 0) {
        ship.status = 'insufficient-fuel';
        this._raiseAlert({
          type: 'insufficient-fuel',
          severity: 'high',
          shipId: ship.id,
          message: `${ship.name} does not have enough fuel to reach ${ship.destination.name} on its current route`,
        });
      } else if (ship.status === 'insufficient-fuel' && rangeLeftKm >= remainingRouteKm) {
        ship.status = 'rerouting';
      }

      // Zone breach check (ship currently inside a live zone).
      const insideZone = this.zones.find((z) => pointInPolygon(ship, z.polygon));
      if (insideZone) {
        if (ship.status !== 'distressed') {
          if (ship.status !== 'rerouting' || !ship._lastBreachZone || ship._lastBreachZone !== insideZone.id) {
            this._raiseAlert({
              type: 'geofence-breach',
              severity: 'high',
              shipId: ship.id,
              message: `${ship.name} breached restricted zone "${insideZone.label}"`,
            });
            ship._lastBreachZone = insideZone.id;
            ship.status = 'rerouting';
            this._recomputeRoute(ship);
          }
        }
      } else {
        ship._lastBreachZone = null;
        if (ship.status === 'rerouting' && ship.routeTarget >= ship.route.length) {
          ship.status = 'normal';
        }
      }

      if (!['rerouting', 'distressed', 'insufficient-fuel', 'stopped', 'out-of-fuel', 'stranded', 'arrived'].includes(ship.status)) {
        ship.status = 'normal';
      }
    });

    this._checkProximity();
    this._pushHistory();
    this._emit('update', this.snapshot());
  }

  _remainingRouteKm(ship) {
    let total = 0;
    let prev = { lat: ship.lat, lng: ship.lng };
    for (let i = ship.routeTarget; i < ship.route.length; i++) {
      total += haversineKm(prev, ship.route[i]);
      prev = ship.route[i];
    }
    return total;
  }

  _pushHistory() {
    const now = Date.now();
    if (now - this._lastHistoryPush < HISTORY_INTERVAL_MS) return;
    this._lastHistoryPush = now;
    this.history.push({
      t: now,
      ships: this.ships.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, status: s.status, fuel: s.fuel })),
      alertCount: this.alerts.filter((a) => !a.resolvedAt).length,
    });
    if (this.history.length > HISTORY_MAX_SNAPSHOTS) this.history.shift();
  }

  snapshot() {
    return {
      t: Date.now(),
      ships: this.ships.map((s) => ({
        id: s.id, name: s.name, lat: s.lat, lng: s.lng, heading: s.heading, speed: s.speed,
        destination: s.destination, fuel: s.fuel, cargo: s.cargo, status: s.status,
        route: s.route, pendingDirective: s.pendingDirective, lastDirectiveResponse: s.lastDirectiveResponse,
        inAdverseWeather: s.inAdverseWeather,
      })),
      zones: this.zones,
      alerts: this.alerts.slice(0, 50),
      weatherFallback: this.weather ? this.weather.usingFallback : false,
    };
  }
}

module.exports = { Simulation, TICK_HZ, PROXIMITY_KM };
