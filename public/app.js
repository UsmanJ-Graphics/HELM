// app.js — single client for both Command and Captain roles.
// The server is the only source of truth; this file renders whatever it
// broadcasts and forwards user actions back as websocket messages.

(function () {
  'use strict';

  // ---------------- state ----------------
  let ws = null;
  let role = 'command';
  let myShipId = null;

  let latestSnapshot = null;
  let prevSnapshot = null;
  let prevAt = 0;
  let currAt = 0;
  const ESTIMATED_TICK_MS = 1000; // server ticks ~1Hz; used only for interpolation pacing

  let selectedShipId = null;
  let historyData = [];
  let liveMode = true;
  let alertAudioContext = null;

  // ---------------- map setup ----------------
  const map = L.map('map', { zoomControl: true, attributionControl: false })
    .setView([25.8, 56.2], 7);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    subdomains: 'abc', maxZoom: 12,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const zonesLayer = L.layerGroup().addTo(map);
  const shipsLayer = L.layerGroup().addTo(map);
  const routesLayer = L.layerGroup().addTo(map);
  const ghostLayer = L.layerGroup().addTo(map);

  const markers = new Map(); // shipId -> {marker, labelMarker}

  const drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);
  let drawControl = null;

  function shipDivIcon(status, heading) {
    const cls = `ship-icon st-${status}`;
    return L.divIcon({
      html: `<svg class="${cls}" width="20" height="20" viewBox="0 0 24 24" style="transform:rotate(${heading}deg)">
        <path d="M12 2 L19 20 L12 16 L5 20 Z" fill="currentColor" stroke="#08111C" stroke-width="1"/>
      </svg>`,
      className: '', iconSize: [20, 20], iconAnchor: [10, 10],
    });
  }

  // ---------------- websocket ----------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      setConnBadge(true);
      sendHello();
    };
    ws.onclose = () => { setConnBadge(false); setTimeout(connect, 1500); };
    ws.onerror = () => ws.close();

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.kind === 'state') handleState(msg.snapshot);
      else if (msg.kind === 'alert') flashAlert(msg.alert);
      else if (msg.kind === 'directive_response') {} // state update covers UI
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function sendHello() {
    send({ type: 'hello', role, shipId: role === 'captain' ? myShipId : null });
  }

  function setConnBadge(ok) {
    const el = document.getElementById('connBadge');
    el.textContent = ok ? 'Connected' : 'Reconnecting…';
    el.className = 'badge ' + (ok ? 'connected' : 'disconnected');
  }

  // ---------------- state handling ----------------
  function handleState(snapshot) {
    prevSnapshot = latestSnapshot || snapshot;
    prevAt = currAt || performance.now();
    latestSnapshot = snapshot;
    currAt = performance.now();

    renderZones(snapshot.zones);
    renderAlerts(snapshot.alerts);
    renderCaptainPanel(snapshot);
    renderShipDetail(snapshot);
    document.getElementById('weatherBadge').classList.toggle('hidden', !snapshot.weatherFallback);
    document.getElementById('clockValue').textContent = new Date(snapshot.t).toLocaleTimeString();
  }

  function flashAlert(alert) {
    if (alert.severity === 'critical' || alert.severity === 'high') {
      const badge = document.getElementById('connBadge');
      badge.style.boxShadow = '0 0 0 2px var(--red)';
      setTimeout(() => (badge.style.boxShadow = ''), 600);
      playAlertTone(alert.severity);
    }
  }

  // Web Audio avoids a bundled media asset and lets urgent alerts be heard
  // immediately after the operator's first interaction with the dashboard.
  function unlockAlertAudio() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    alertAudioContext = alertAudioContext || new AudioCtx();
    if (alertAudioContext.state === 'suspended') alertAudioContext.resume();
  }

  function playAlertTone(severity) {
    unlockAlertAudio();
    if (!alertAudioContext || alertAudioContext.state !== 'running') return;
    const oscillator = alertAudioContext.createOscillator();
    const gain = alertAudioContext.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = severity === 'critical' ? 880 : 660;
    gain.gain.setValueAtTime(0.001, alertAudioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, alertAudioContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, alertAudioContext.currentTime + 0.26);
    oscillator.connect(gain).connect(alertAudioContext.destination);
    oscillator.start();
    oscillator.stop(alertAudioContext.currentTime + 0.28);
  }

  document.addEventListener('pointerdown', unlockAlertAudio, { once: true });

  // ---------------- interpolated rendering ----------------
  function animate() {
    if (liveMode && latestSnapshot) {
      const t = Math.min(1, (performance.now() - currAt) / ESTIMATED_TICK_MS);
      renderShips(latestSnapshot.ships, prevSnapshot ? prevSnapshot.ships : latestSnapshot.ships, Math.min(1, Math.max(0, t)));
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  function lerp(a, b, t) { return a + (b - a) * t; }

  function renderShips(current, previous, t) {
    const prevById = new Map(previous.map((s) => [s.id, s]));
    current.forEach((ship) => {
      const prev = prevById.get(ship.id) || ship;
      const lat = lerp(prev.lat, ship.lat, t);
      const lng = lerp(prev.lng, ship.lng, t);
      let entry = markers.get(ship.id);
      if (!entry) {
        const marker = L.marker([lat, lng], { icon: shipDivIcon(ship.status, ship.heading) }).addTo(shipsLayer);
        marker.on('click', () => { selectedShipId = ship.id; renderShipDetail(latestSnapshot); });
        const label = L.marker([lat, lng], {
          icon: L.divIcon({ className: '', html: `<div class="ship-label">${ship.name}</div>`, iconAnchor: [-10, 6] }),
          interactive: false,
        }).addTo(shipsLayer);
        entry = { marker, label, lastStatus: ship.status, lastHeading: ship.heading };
        markers.set(ship.id, entry);
      }
      entry.marker.setLatLng([lat, lng]);
      entry.label.setLatLng([lat, lng]);
      if (entry.lastStatus !== ship.status || Math.abs(entry.lastHeading - ship.heading) > 3) {
        entry.marker.setIcon(shipDivIcon(ship.status, ship.heading));
        entry.lastStatus = ship.status;
        entry.lastHeading = ship.heading;
      }
    });

    // routes for selected ship (or all, for Command, lightly)
    routesLayer.clearLayers();
    const ship = current.find((s) => s.id === (selectedShipId || myShipId));
    if (ship && ship.route && ship.route.length > 1) {
      L.polyline(ship.route.map((p) => [p.lat, p.lng]), { color: '#2DD4BF', weight: 2, dashArray: '4 4', opacity: 0.7 }).addTo(routesLayer);
    }
  }

  function renderZones(zones) {
    zonesLayer.clearLayers();
    (zones || []).forEach((z) => {
      const latlngs = z.polygon.map(([lng, lat]) => [lat, lng]);
      const poly = L.polygon(latlngs, { color: '#E5484D', weight: 2, fillColor: '#E5484D', fillOpacity: 0.12 }).addTo(zonesLayer);
      poly.bindTooltip(z.label, { permanent: false });
      if (role === 'command') {
        poly.on('contextmenu', () => { if (confirm(`Remove zone "${z.label}"?`)) send({ type: 'remove_zone', zoneId: z.id }); });
      }
    });
  }

  // ---------------- alerts panel ----------------
  function renderAlerts(alerts) {
    const list = document.getElementById('alertsList');
    document.getElementById('alertCount').textContent = alerts.filter((a) => !a.resolvedAt).length;
    list.innerHTML = '';
    alerts.slice(0, 30).forEach((a) => {
      const div = document.createElement('div');
      div.className = `alert-item sev-${a.severity}` + (a.acknowledged ? ' acked' : '');
      div.innerHTML = `
        <div class="alert-top">
          <span class="alert-type">${a.type.replace(/-/g, ' ')}</span>
          ${a.acknowledged ? '' : `<button class="alert-ack" data-id="${a.id}">Ack</button>`}
        </div>
        <div>${a.message}</div>
        <div class="muted small">${new Date(a.createdAt).toLocaleTimeString()}</div>
      `;
      list.appendChild(div);
    });
    list.querySelectorAll('.alert-ack').forEach((btn) => {
      btn.addEventListener('click', () => send({ type: 'ack_alert', alertId: btn.dataset.id }));
    });
  }

  // ---------------- ship detail panel ----------------
  function renderShipDetail(snapshot) {
    const panel = document.getElementById('shipDetailPanel');
    const id = selectedShipId || (role === 'captain' ? myShipId : null);
    const ship = snapshot && snapshot.ships.find((s) => s.id === id);
    if (!ship) {
      panel.querySelector('.panel-body').innerHTML = '<span class="muted">Click a ship on the map for details.</span>';
      return;
    }
    panel.querySelector('.panel-body').innerHTML = `
      <div class="detail-row"><span class="k">Name</span><span class="v">${ship.name}</span></div>
      <div class="detail-row"><span class="k">Status</span><span class="status-tag status-${ship.status}">${ship.status.replace(/-/g, ' ')}</span></div>
      <div class="detail-row"><span class="k">Destination</span><span class="v">${ship.destination.name}</span></div>
      <div class="detail-row"><span class="k">Speed</span><span class="v">${ship.speed.toFixed(1)} km/h</span></div>
      <div class="detail-row"><span class="k">Heading</span><span class="v">${ship.heading.toFixed(0)}°</span></div>
      <div class="detail-row"><span class="k">Fuel</span><span class="v">${ship.fuel.toFixed(1)}%</span></div>
      <div class="detail-row"><span class="k">Cargo</span><span class="v">${ship.cargo.type} · ${ship.cargo.amount}t</span></div>
      <div class="detail-row"><span class="k">Weather</span><span class="v">${ship.inAdverseWeather ? 'Adverse' : 'Clear'}</span></div>
      ${role === 'command' ? `<div style="margin-top:10px"><button class="tool-btn small" id="issueDirectiveBtn">Issue Directive</button></div>` : ''}
    `;
    const btn = document.getElementById('issueDirectiveBtn');
    if (btn) btn.addEventListener('click', () => openDirectiveDialog(ship));
  }

  function openDirectiveDialog(ship) {
    const type = prompt('Directive type: reroute / divert-waypoint / hold', 'hold');
    if (!type) return;
    let payload = {};
    if (type === 'reroute' || type === 'divert-waypoint') {
      const lat = parseFloat(prompt('New destination latitude', ship.destination.lat));
      const lng = parseFloat(prompt('New destination longitude', ship.destination.lng));
      const name = prompt('Destination label', 'New Waypoint') || 'New Waypoint';
      if (isNaN(lat) || isNaN(lng)) return;
      payload = { destination: { name, lat, lng }, waypoint: { name, lat, lng } };
    }
    send({ type: 'issue_directive', shipId: ship.id, directive: { type, payload } });
  }

  // ---------------- captain panel ----------------
  function renderCaptainPanel(snapshot) {
    const panel = document.getElementById('captainPanel');
    if (role !== 'captain' || !myShipId) { panel.innerHTML = ''; return; }
    const ship = snapshot.ships.find((s) => s.id === myShipId);
    if (!ship) { panel.innerHTML = ''; return; }

    if (!ship.pendingDirective) {
      panel.innerHTML = `<div class="panel-body muted">No pending directive for ${ship.name}. Standing by.</div>`;
      return;
    }
    const d = ship.pendingDirective;
    panel.innerHTML = `
      <div class="directive-box">
        <h4>Directive Received — ${d.type.replace(/-/g, ' ')}</h4>
        <div class="small muted">${d.payload && d.payload.destination ? 'New destination: ' + d.payload.destination.name : ''}</div>
        <textarea class="distress-textarea" id="distressText" placeholder="Describe the emergency (e.g. 'fire in engine room, 2 injured')"></textarea>
        <div class="directive-actions">
          <button class="btn-accept" id="acceptBtn">ACCEPT</button>
          <button class="btn-escalate" id="escalateBtn">ESCALATE DISTRESS</button>
        </div>
      </div>
    `;
    document.getElementById('acceptBtn').addEventListener('click', () => {
      send({ type: 'respond_directive', shipId: myShipId, response: 'ACCEPT', payload: d.payload });
    });
    document.getElementById('escalateBtn').addEventListener('click', () => {
      const ta = document.getElementById('distressText');
      if (ta.style.display !== 'block') { ta.style.display = 'block'; ta.focus(); return; }
      send({ type: 'respond_directive', shipId: myShipId, response: 'ESCALATE_DISTRESS', payload: { message: ta.value } });
    });
  }

  // ---------------- role switching ----------------
  function setupRoleSwitch() {
    const shipSelect = document.getElementById('captainShipSelect');
    for (let i = 1; i <= 15; i++) {
      const id = `ship-${String(i).padStart(2, '0')}`;
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = id;
      shipSelect.appendChild(opt);
    }
    myShipId = shipSelect.value;

    document.querySelectorAll('.role-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.role-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        role = btn.dataset.role;
        shipSelect.classList.toggle('hidden', role !== 'captain');
        document.getElementById('mapToolbar').classList.toggle('hidden', role !== 'command');
        document.getElementById('timelinePanel').classList.toggle('hidden', role !== 'command');
        selectedShipId = role === 'captain' ? myShipId : selectedShipId;
        sendHello();
        if (latestSnapshot) { renderCaptainPanel(latestSnapshot); renderShipDetail(latestSnapshot); }
      });
    });
    shipSelect.addEventListener('change', () => {
      myShipId = shipSelect.value;
      selectedShipId = myShipId;
      sendHello();
      if (latestSnapshot) { renderCaptainPanel(latestSnapshot); renderShipDetail(latestSnapshot); }
    });

    document.getElementById('mapToolbar').classList.remove('hidden');
    document.getElementById('timelinePanel').classList.remove('hidden');
  }

  // ---------------- zone drawing (Command only) ----------------
  function setupDrawing() {
    const drawBtn = document.getElementById('drawZoneBtn');
    const hint = document.getElementById('drawHint');
    let drawer = null;

    drawBtn.addEventListener('click', () => {
      if (role !== 'command') { alert('Only Command can draw restricted zones.'); return; }
      hint.classList.remove('hidden');
      drawer = new L.Draw.Polygon(map, { shapeOptions: { color: '#E5484D' } });
      drawer.enable();
    });

    map.on(L.Draw.Event.CREATED, (e) => {
      hint.classList.add('hidden');
      const latlngs = e.layer.getLatLngs()[0].map((p) => ({ lat: p.lat, lng: p.lng }));
      const label = prompt('Zone label', 'Restricted Zone') || 'Restricted Zone';
      send({ type: 'draw_zone', polygon: latlngs, label });
    });
  }

  // ---------------- playback / timeline ----------------
  async function loadHistory() {
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      historyData = data.history || [];
      const slider = document.getElementById('timelineSlider');
      slider.max = Math.max(0, historyData.length - 1);
      slider.value = slider.max;
    } catch (e) { /* offline / not ready yet */ }
  }
  setInterval(loadHistory, 30000);
  loadHistory();

  document.getElementById('timelineSlider').addEventListener('input', (e) => {
    const idx = parseInt(e.target.value, 10);
    const snap = historyData[idx];
    if (!snap) return;
    liveMode = false;
    document.getElementById('timelineLabel').textContent = new Date(snap.t).toLocaleTimeString() + ` (${snap.alertCount} active alerts)`;
    ghostLayer.clearLayers();
    shipsLayer.eachLayer((l) => map.removeLayer(l));
    snap.ships.forEach((s) => {
      L.circleMarker([s.lat, s.lng], { radius: 5, color: '#7C93A8', fillColor: '#7C93A8', fillOpacity: 0.6, weight: 1 })
        .bindTooltip(s.id).addTo(ghostLayer);
    });
  });

  document.getElementById('timelineLiveBtn').addEventListener('click', () => {
    liveMode = true;
    ghostLayer.clearLayers();
    map.addLayer(shipsLayer);
    document.getElementById('timelineLabel').textContent = 'Live';
    document.getElementById('timelineSlider').value = document.getElementById('timelineSlider').max;
  });

  // ---------------- init ----------------
  setupRoleSwitch();
  setupDrawing();
  connect();

})();
