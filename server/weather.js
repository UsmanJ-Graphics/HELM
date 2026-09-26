// weather.js — pulls live conditions from Open-Meteo (no API key required):
//   - api.open-meteo.com          -> wind speed / gusts
//   - marine-api.open-meteo.com   -> wave height
//
// We don't hit the API once per ship per tick (rate-limit risk + latency).
// Instead we snap ships onto a coarse 0.5deg grid over the operating area,
// fetch each grid cell on a slower interval, and cache the result. Ships
// read from the cache every tick. If the API is unreachable (offline demo /
// judging without internet), we fall back to a seeded synthetic weather
// field so the rest of the system keeps working — this fallback is a
// documented assumption, not a silent failure.

const fetch = require('node-fetch');

const GRID_STEP = 0.5; // degrees
const ADVERSE_WIND_KMH = 35; // gusts above this = adverse
const ADVERSE_WAVE_M = 2.0; // wave height above this = adverse
const REFRESH_MS = 5 * 60 * 1000; // refresh grid every 5 minutes

function snap(v) {
  return Math.round(v / GRID_STEP) * GRID_STEP;
}
function cellKey(lat, lng) {
  return `${snap(lat).toFixed(2)},${snap(lng).toFixed(2)}`;
}

class WeatherService {
  constructor(bbox) {
    this.bbox = bbox;
    this.cache = new Map(); // cellKey -> {windSpeed, windGusts, waveHeight, adverse, lat, lng, updatedAt}
    this.usingFallback = false;
    this._buildGrid();
  }

  _buildGrid() {
    this.cells = [];
    for (let lat = this.bbox.minLat; lat <= this.bbox.maxLat; lat += GRID_STEP) {
      for (let lng = this.bbox.minLng; lng <= this.bbox.maxLng; lng += GRID_STEP) {
        this.cells.push({ lat: snap(lat), lng: snap(lng) });
      }
    }
  }

  async start() {
    await this.refresh();
    this._timer = setInterval(() => this.refresh().catch(() => {}), REFRESH_MS);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async _fetchCell(lat, lng) {
    const [windRes, waveRes] = await Promise.all([
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=wind_speed_10m,wind_gusts_10m&wind_speed_unit=kmh`
      ),
      fetch(
        `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}&current=wave_height`
      ),
    ]);
    if (!windRes.ok || !waveRes.ok) throw new Error('weather fetch failed');
    const wind = await windRes.json();
    const wave = await waveRes.json();
    const windSpeed = wind?.current?.wind_speed_10m ?? 0;
    const windGusts = wind?.current?.wind_gusts_10m ?? windSpeed;
    const waveHeight = wave?.current?.wave_height ?? 0;
    return { windSpeed, windGusts, waveHeight };
  }

  _syntheticCell(lat, lng, t) {
    // Deterministic pseudo-random field so a "storm" drifts smoothly across
    // the map over time, purely so the demo has adverse weather to show.
    const phase = (lat * 12.9898 + lng * 78.233) % 1;
    const wave = 1.2 + 1.6 * Math.abs(Math.sin(t / 900000 + phase * 10));
    const wind = 15 + 30 * Math.abs(Math.sin(t / 700000 + phase * 7));
    return { windSpeed: wind, windGusts: wind * 1.3, waveHeight: wave };
  }

  async refresh() {
    try {
      const results = await Promise.all(
        this.cells.map(async (c) => {
          const data = await this._fetchCell(c.lat, c.lng);
          return { ...c, ...data };
        })
      );
      results.forEach((r) => {
        const adverse = r.windGusts >= ADVERSE_WIND_KMH || r.waveHeight >= ADVERSE_WAVE_M;
        this.cache.set(cellKey(r.lat, r.lng), { ...r, adverse, updatedAt: Date.now() });
      });
      this.usingFallback = false;
    } catch (err) {
      // Offline fallback — keeps ticks flowing without a network dependency.
      this.usingFallback = true;
      const t = Date.now();
      this.cells.forEach((c) => {
        const data = this._syntheticCell(c.lat, c.lng, t);
        const adverse = data.windGusts >= ADVERSE_WIND_KMH || data.waveHeight >= ADVERSE_WAVE_M;
        this.cache.set(cellKey(c.lat, c.lng), { ...c, ...data, adverse, updatedAt: t, synthetic: true });
      });
    }
  }

  conditionsAt(lat, lng) {
    const key = cellKey(lat, lng);
    return (
      this.cache.get(key) || {
        lat: snap(lat), lng: snap(lng), windSpeed: 0, windGusts: 0, waveHeight: 0, adverse: false,
      }
    );
  }

  // Circles the routing engine should treat as "avoid if possible".
  stormCells(radiusKm = 40) {
    const out = [];
    for (const v of this.cache.values()) {
      if (v.adverse) out.push({ lat: v.lat, lng: v.lng, radiusKm });
    }
    return out;
  }
}

module.exports = { WeatherService, ADVERSE_WIND_KMH, ADVERSE_WAVE_M };
