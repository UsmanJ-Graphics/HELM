import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { io, Socket } from 'socket.io-client';
import {
  Activity, Anchor, Check, ChevronRight, CloudLightning, Compass, Crosshair,
  MapPin, Minus, Pause, Play, Plus, ScanLine, Ship as ShipIcon, TriangleAlert, X,
} from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import './styles.css';

type Point = { lat: number; lng: number };
type ShipData = {
  id: string; name: string; latitude: number; longitude: number; speed: number; heading: number;
  destination: { name: string; lat: number; lng: number }; fuel: number; fuelCapacityTons: number; cargo: { type: string };
  status: string; route: Point[]; weather: any; pendingDirective?: any;
};
type AlertData = { id: string; type: string; severity: string; shipId: string | null; message: string; status: string; createdAt: number; metadata?: any };
type FleetState = { ships: ShipData[]; zones: any[]; alerts: AlertData[]; events: any[]; weatherFallback: boolean };
type AccessConfig = { command: boolean; captainShipIds: string[] };
type VesselOption = { id: string; name: string };
type ViewMode = '2D' | '3D';
type FleetFilter = 'ALL' | 'NORMAL' | 'REROUTING' | 'ALERTS';

const apiUrl = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001';
const statusColors: Record<string, string> = {
  NORMAL: '#46e6a5', REROUTING: '#f6c85f', DISTRESSED: '#ff5964', STOPPED: '#93a4b5',
  INSUFFICIENT_FUEL: '#ff9855', STRANDED: '#c18cff', OUT_OF_FUEL: '#ff5964', ARRIVED: '#6cd88f',
};

function shipIcon(ship: ShipData, selected: boolean) {
  const color = statusColors[ship.status] || '#46e6a5';
  return L.divIcon({
    className: `vessel-marker${selected ? ' vessel-marker-selected' : ''}`,
    html: `<span style="--vessel-color:${color};transform:rotate(${ship.heading}deg)">▲</span>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

function coordinate(value: number, axis: 'lat' | 'lng') {
  const hemisphere = axis === 'lat' ? value >= 0 ? 'N' : 'S' : value >= 0 ? 'E' : 'W';
  return `${Math.abs(value).toFixed(4)}° ${hemisphere}`;
}

function MapEvents({ onCursor }: { onCursor: (point: Point) => void }) {
  useMapEvents({ mousemove: event => onCursor({ lat: event.latlng.lat, lng: event.latlng.lng }) });
  return null;
}

function MapFocus({ ship, ships }: { ship: ShipData | undefined; ships: ShipData[] }) {
  const map = useMap();
  const fittedFleet = useRef(false);
  useEffect(() => {
    if (ship) {
      map.flyTo([ship.latitude, ship.longitude], Math.max(map.getZoom(), 8), { duration: 0.9 });
      return;
    }
    if (!ships.length || fittedFleet.current) return;
    map.fitBounds(L.latLngBounds(ships.map(item => L.latLng(item.latitude, item.longitude))), { padding: [60, 60], maxZoom: 7 });
    fittedFleet.current = true;
  }, [map, ship?.id, ships.length]);
  return null;
}

function MapZoomControls() {
  const map = useMap();
  const stopMapEvent = (event: React.SyntheticEvent) => event.stopPropagation();
  return <div className="leaflet-top leaflet-right zoom-control-position">
    <div className="leaflet-control zoom-controls" onMouseDown={stopMapEvent} onDoubleClick={stopMapEvent}>
      <button aria-label="Zoom in" title="Zoom in" onClick={event => { event.stopPropagation(); map.zoomIn(); }}><Plus size={16} /></button>
      <button aria-label="Zoom out" title="Zoom out" onClick={event => { event.stopPropagation(); map.zoomOut(); }}><Minus size={16} /></button>
    </div>
  </div>;
}

function DrawZone({ enabled, points, setPoints }: { enabled: boolean; points: Point[]; setPoints: React.Dispatch<React.SetStateAction<Point[]>> }) {
  useMapEvents({
    click(event) { if (enabled) setPoints(current => [...current, { lat: event.latlng.lat, lng: event.latlng.lng }]); },
  });
  if (!enabled || !points.length) return null;
  const positions = points.map(point => [point.lat, point.lng] as [number, number]);
  return points.length >= 3
    ? <Polygon positions={positions} pathOptions={{ color: '#ff626d', fillColor: '#ff626d', fillOpacity: .18, dashArray: '6 6' }} />
    : <Polyline positions={positions} pathOptions={{ color: '#ff626d', dashArray: '6 6' }} />;
}

function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [state, setState] = useState<FleetState | null>(null);
  const [visualShips, setVisualShips] = useState<ShipData[]>([]);
  const [role, setRole] = useState<'COMMAND' | 'CAPTAIN'>('COMMAND');
  const [captain, setCaptain] = useState('MV-1');
  const [accessConfig, setAccessConfig] = useState<AccessConfig>({ command: false, captainShipIds: [] });
  const [vesselRoster, setVesselRoster] = useState<VesselOption[]>([]);
  const [accessCode, setAccessCode] = useState('');
  const [authSubmitted, setAuthSubmitted] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>('ALL');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('2D');
  const [drawing, setDrawing] = useState(false);
  const [zonePoints, setZonePoints] = useState<Point[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [playback, setPlayback] = useState<number | null>(null);
  const [toast, setToast] = useState('');
  const audio = useRef<AudioContext>();
  const priorShips = useRef<Map<string, ShipData>>(new Map());

  useEffect(() => {
    fetch(`${apiUrl}/api/config`).then(response => response.json()).then(config => { setAccessConfig(config.access || { command: false, captainShipIds: [] }); setVesselRoster(config.vessels || []); }).catch(() => {});
  }, []);

  useEffect(() => {
    const connection = io(apiUrl, { transports: ['websocket'] });
    setSocket(connection);
    connection.on('fleet:state', (next: FleetState) => { if (next.ships.length > 1) setVesselRoster(current => current.length >= next.ships.length ? current : next.ships.map(({ id, name }) => ({ id, name }))); setState(next); });
    connection.on('alert:created', (alert: AlertData) => {
      setToast(alert.message);
      if (['CRITICAL', 'HIGH'].includes(alert.severity) && audio.current) {
        const oscillator = audio.current.createOscillator();
        const gain = audio.current.createGain();
        oscillator.frequency.value = alert.severity === 'CRITICAL' ? 880 : 660;
        gain.gain.value = 0.08;
        oscillator.connect(gain).connect(audio.current.destination);
        oscillator.start();
        oscillator.stop(audio.current.currentTime + 0.22);
      }
    });
    return () => { connection.close(); };
  }, []);

  useEffect(() => {
    if (!socket) return;
    let active = true;
    const accessRequired = role === 'COMMAND' ? accessConfig.command : accessConfig.captainShipIds.length > 0;
    const joinSession = () => {
      setSessionReady(false);
      if (accessRequired && !authSubmitted) { socket.emit('session:leave'); return; }
      socket.emit('session:join', { role, shipId: role === 'CAPTAIN' ? captain : undefined, accessCode }, (response: any) => {
        if (!active) return;
        setSessionReady(Boolean(response?.ok));
        if (!response?.ok) setToast(response?.error || 'Unable to join this session');
      });
    };
    const disconnected = () => setSessionReady(false);
    socket.on('connect', joinSession);
    socket.on('disconnect', disconnected);
    if (socket.connected) joinSession();
    return () => { active = false; socket.off('connect', joinSession); socket.off('disconnect', disconnected); };
  }, [socket, role, captain, accessConfig, accessCode, authSubmitted]);

  useEffect(() => {
    if (!state) return;
    const previous = priorShips.current;
    const target = state.ships;
    const started = performance.now();
    let frame = 0;
    const animate = () => {
      const progress = Math.min(1, (performance.now() - started) / 900);
      setVisualShips(target.map(ship => {
        const old = previous.get(ship.id) || ship;
        const headingDelta = ((ship.heading - old.heading + 540) % 360) - 180;
        return {
          ...ship,
          latitude: old.latitude + (ship.latitude - old.latitude) * progress,
          longitude: old.longitude + (ship.longitude - old.longitude) * progress,
          heading: (old.heading + headingDelta * progress + 360) % 360,
        };
      }));
      if (progress < 1) frame = requestAnimationFrame(animate);
      else priorShips.current = new Map(target.map(ship => [ship.id, ship]));
    };
    animate();
    return () => cancelAnimationFrame(frame);
  }, [state]);

  useEffect(() => {
    const params = new URLSearchParams({ role });
    if (role === 'CAPTAIN') params.set('shipId', captain);
    fetch(`${apiUrl}/api/history?${params}`, { headers: accessCode ? { 'x-access-code': accessCode } : {} })
      .then(response => response.ok ? response.json() : { history: [] })
      .then(result => setHistory(result.history || [])).catch(() => setHistory([]));
  }, [role, captain, accessCode]);

  const ships = state?.ships || [];
  const visibleShips = role === 'CAPTAIN' ? ships.filter(ship => ship.id === captain) : ships;
  const selectedShip = ships.find(ship => ship.id === (selectedId || (role === 'CAPTAIN' ? captain : null)));
  const hoveredShip = ships.find(ship => ship.id === hoveredId);
  const detailShip = role === 'CAPTAIN' ? selectedShip : hoveredShip || selectedShip;
  const selectedZone = state?.zones.find(zone => zone.id === selectedZoneId);
  const activeAlerts = state?.alerts.filter(alert => alert.status === 'ACTIVE' &&
    (role !== 'CAPTAIN' || !alert.shipId || alert.shipId === captain)) || [];
  const normalCount = visibleShips.filter(ship => ship.status === 'NORMAL').length;
  const reroutingCount = visibleShips.filter(ship => ship.status === 'REROUTING').length;
  const alertShipIds = new Set(activeAlerts.flatMap(alert => alert.shipId ? [alert.shipId] : []));
  const sidebarShips = visibleShips.filter(ship => fleetFilter === 'ALL' ||
    (fleetFilter === 'NORMAL' && ship.status === 'NORMAL') ||
    (fleetFilter === 'REROUTING' && ship.status === 'REROUTING') ||
    (fleetFilter === 'ALERTS' && alertShipIds.has(ship.id)));
  const historyFrames = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const row of history) {
      const key = new Date(row.timestamp).toISOString();
      const frame = groups.get(key) || [];
      frame.push({ ...row, id: row.ship_id, latitude: Number(row.latitude), longitude: Number(row.longitude) });
      groups.set(key, frame);
    }
    return Array.from(groups, ([timestamp, frameShips]) => ({ timestamp, ships: frameShips }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [history]);
  const playbackFleet = playback === null ? visualShips : historyFrames[playback]?.ships || [];
  const playbackShips = role === 'CAPTAIN' ? playbackFleet.filter(ship => ship.id === captain) : playbackFleet;

  const emit = (event: string, payload: any, done?: (response: any) => void) => {
    socket?.emit(event, payload, (response: any) => {
      if (!response?.ok) setToast(response?.error || 'Request rejected');
      else done?.(response);
    });
  };
  const enableAudio = () => {
    audio.current = audio.current || new AudioContext();
    void audio.current.resume();
  };
  const issueDirective = (ship: ShipData) => {
    const type = window.prompt('Directive: REROUTE, WAYPOINT or HOLD', 'HOLD')?.toUpperCase();
    if (!type) return;
    let payload = {};
    if (type !== 'HOLD') {
      const lat = Number(window.prompt('Latitude', String(ship.destination.lat)));
      const lng = Number(window.prompt('Longitude', String(ship.destination.lng)));
      payload = { destination: { name: window.prompt('Port name', 'New waypoint') || 'New waypoint', lat, lng } };
    }
    emit('directive:create', { shipId: ship.id, type, payload });
  };
  const changeRole = (nextRole: 'COMMAND' | 'CAPTAIN') => {
    if (nextRole === role) return;
    setSelectedId(null); setHoveredId(null); setSessionReady(false); setAccessCode(''); setAuthSubmitted(false); setRole(nextRole);
  };
  const editZone = (zone: any) => {
    const name = window.prompt('Restricted-zone name', zone.name);
    if (!name) return;
    const raw = window.prompt('Polygon points as JSON [{"lat":26,"lng":56}, ...]', JSON.stringify(zone.polygon));
    if (!raw) return;
    try {
      const polygon = JSON.parse(raw);
      if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some((point: any) => !Number.isFinite(point.lat) || !Number.isFinite(point.lng))) throw new Error();
      emit('zone:update', { id: zone.id, name, polygon });
      setSelectedZoneId(null);
    } catch { setToast('Enter at least three valid latitude/longitude points'); }
  };
  const deleteZone = (zone: any) => {
    if (!window.confirm(`Remove restrictions for “${zone.name}”?`)) return;
    emit('zone:delete', zone.id, () => { setSelectedZoneId(null); setToast(`Restrictions removed: ${zone.name}`); });
  };
  const startDrawing = () => { setZonePoints([]); setSelectedZoneId(null); setDrawing(true); };
  const cancelDrawing = () => { setDrawing(false); setZonePoints([]); };
  const finishDrawing = () => {
    if (zonePoints.length < 3) return;
    const name = window.prompt('Name this restricted zone', 'Restricted zone');
    if (!name?.trim()) return;
    emit('zone:create', { name: name.trim(), polygon: zonePoints }, response => {
      setToast('Restricted zone saved. Intersecting ship routes are being recalculated.');
      setSelectedZoneId(response?.data?.id || null);
    });
    cancelDrawing();
  };

  return <div className="shell" onPointerDown={enableAudio}>
    <header className="topbar">
      <div className="brand"><Anchor size={21} /><span>HELM</span><small>MARITIME OPERATIONS</small></div>
      <div className="top-status"><span className="live-dot" /> LIVE FEED <b>{ships.length} VESSELS</b></div>
      <div className="role-switch">
        <button className={role === 'COMMAND' ? 'active' : ''} onClick={() => changeRole('COMMAND')}>COMMAND</button>
        <button className={role === 'CAPTAIN' ? 'active' : ''} onClick={() => changeRole('CAPTAIN')}>CAPTAIN</button>
        {role === 'CAPTAIN' && <select className="captain-ship-select" aria-label="Assigned ship" value={captain} disabled={!vesselRoster.length} onChange={event => { setSelectedId(null); setHoveredId(null); setSessionReady(false); setAccessCode(''); setAuthSubmitted(false); setCaptain(event.target.value); }}>{!vesselRoster.length && <option value="">Loading ships…</option>}{vesselRoster.map(vessel => <option key={vessel.id} value={vessel.id}>{vessel.name}</option>)}</select>}
        {(role === 'COMMAND' ? accessConfig.command : accessConfig.captainShipIds.length > 0) && <><input className="access-code" type="password" autoComplete="current-password" aria-label={`${role} access code`} placeholder={`${role} CODE`} value={accessCode} onChange={event => { setAccessCode(event.target.value); setAuthSubmitted(false); setSessionReady(false); }} /><button className="access-submit" onClick={() => setAuthSubmitted(true)}>{sessionReady ? 'AUTHORIZED' : 'CONNECT'}</button></>}
      </div>
    </header>

    <main className="workspace">
      <aside className="fleet-panel">
        <div className="panel-heading"><span>{role === 'CAPTAIN' ? 'ASSIGNED VESSEL' : 'FLEET OVERVIEW'}</span><b>{visibleShips.length.toString().padStart(2, '0')} / {role === 'CAPTAIN' ? '01' : '15'}</b></div>
        <div className="metrics">
          <Metric number={normalCount} label="NORMAL" active={fleetFilter === 'NORMAL'} onClick={() => setFleetFilter(fleetFilter === 'NORMAL' ? 'ALL' : 'NORMAL')} />
          <Metric number={reroutingCount} label="REROUTING" active={fleetFilter === 'REROUTING'} onClick={() => setFleetFilter(fleetFilter === 'REROUTING' ? 'ALL' : 'REROUTING')} />
          <Metric number={activeAlerts.length} label="ALERTS" active={fleetFilter === 'ALERTS'} onClick={() => setFleetFilter(fleetFilter === 'ALERTS' ? 'ALL' : 'ALERTS')} />
        </div>
        <div className="list-heading"><span>{fleetFilter === 'ALL' ? 'ACTIVE VESSELS' : `${fleetFilter} VESSELS`}</span>
          <button onClick={() => setFleetFilter('ALL')} aria-pressed={fleetFilter === 'ALL'}>ALL · {visibleShips.length}</button></div>
        <div className="ship-list">
          {sidebarShips.map(ship => <button key={ship.id}
            className={`ship-row${selectedShip?.id === ship.id ? ' selected' : ''}${hoveredId === ship.id ? ' hovered' : ''}`}
            onClick={() => setSelectedId(ship.id)} onMouseEnter={() => setHoveredId(ship.id)} onMouseLeave={() => setHoveredId(null)}>
            <i className="ship-dot" style={{ background: statusColors[ship.status] || '#46e6a5' }} />
            <span className="ship-row-copy"><strong>{ship.name}</strong><small>{ship.status.replaceAll('_', ' ')} · {(ship.speed / 1.852).toFixed(1)} kn</small></span>
            <ChevronRight size={14} />
          </button>)}
          {!sidebarShips.length && <div className="fleet-empty">No ships in this filter</div>}
        </div>
      </aside>

      <section className={`map-wrap${viewMode === '3D' ? ' mode-3d' : ''}`}>
        <div className="map-surface">
          <MapContainer center={[26, 56]} zoom={7} zoomControl={false} doubleClickZoom={false} preferCanvas>
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapEvents onCursor={setCursor} />
            <MapFocus ship={selectedShip} ships={visibleShips} />
            <MapZoomControls />
            <DrawZone enabled={drawing} points={zonePoints} setPoints={setZonePoints} />
            {state?.zones.map(zone => <Polygon key={zone.id} positions={zone.polygon.map((point: Point) => [point.lat, point.lng])}
              pathOptions={{ color: selectedZoneId === zone.id ? '#ff8a91' : '#ff414d', fillColor: '#ff414d', fillOpacity: selectedZoneId === zone.id ? 0.24 : 0.18, weight: selectedZoneId === zone.id ? 4 : 3, dashArray: '8 5' }}
              eventHandlers={{ click: () => { if (role === 'COMMAND') setSelectedZoneId(zone.id); } }}>
              <Tooltip sticky>{zone.name}</Tooltip>
            </Polygon>)}
            {playbackShips.map(ship => <Marker key={ship.id} position={[ship.latitude, ship.longitude]}
              icon={shipIcon(ship, selectedShip?.id === ship.id)}
              eventHandlers={{ click: () => { if (role === 'COMMAND' || ship.id === captain) setSelectedId(ship.id); }, mouseover: () => setHoveredId(ship.id), mouseout: () => setHoveredId(null) }}>
              <Tooltip className="ship-tooltip-wrap" direction="top" offset={[0, -13]} opacity={1}>
                <div className="ship-tooltip"><strong>{ship.name}</strong><span>{ship.status.replaceAll('_', ' ')}</span>
                  <small>{ship.latitude.toFixed(4)}°, {ship.longitude.toFixed(4)}° · {(ship.speed / 1.852).toFixed(1)} kn</small></div>
              </Tooltip>
            </Marker>)}
            {selectedShip && selectedShip.route.length > 0 && <Polyline positions={selectedShip.route.map(point => [point.lat, point.lng])}
              pathOptions={{ color: '#39e69b', weight: 2, dashArray: '5 8', opacity: 0.9 }} />}
          </MapContainer>
        </div>

        <div className="map-toolbar">
          <div className="map-mode"><button className={viewMode === '2D' ? 'active' : ''} onClick={() => setViewMode('2D')}>2D</button>
            <button className={viewMode === '3D' ? 'active' : ''} onClick={() => setViewMode('3D')}>3D</button></div>
          {role === 'COMMAND' && (drawing ? <div className="zone-draw-controls">
            <span>CLICK MAP TO ADD POINTS · {zonePoints.length}</span>
            <button className="map-action zone-confirm" disabled={zonePoints.length < 3} onClick={finishDrawing}><Check size={13} /> OK</button>
            <button className="map-action cancel" onClick={cancelDrawing}><X size={13} /> CANCEL</button>
          </div> : <button className="map-action" onClick={startDrawing}><MapPin size={14} /> DRAW RESTRICTED ZONE</button>)}
          {selectedZone && role === 'COMMAND' && <>
            <button className="map-action zone-edit" onClick={() => editZone(selectedZone)}>EDIT: {selectedZone.name}</button>
            <button className="map-action zone-delete" onClick={() => deleteZone(selectedZone)}>REMOVE RESTRICTIONS</button>
            <button className="map-action" aria-label="Deselect zone" onClick={() => setSelectedZoneId(null)}><X size={13} /></button>
          </>}
        </div>

        <div className="map-readout">
          <div><span><Crosshair size={13} /> MAP CURSOR</span><strong>{cursor ? `${cursor.lat.toFixed(4)}°  ${cursor.lng.toFixed(4)}°` : 'MOVE OVER MAP'}</strong></div>
          <i />
          <div><span><ShipIcon size={13} /> {detailShip ? detailShip.name.toUpperCase() : 'FLEET POSITION'}</span>
            <strong>{detailShip ? `${coordinate(detailShip.latitude, 'lat')}  ${coordinate(detailShip.longitude, 'lng')}` : `${ships.length} TRACKED`}</strong></div>
          <i />
          <div className="weather-readout" title="Wind conditions are sampled for fleet positions and destinations. Fallback is used if live weather is unavailable.">
            <span><CloudLightning size={13} /> WEATHER</span><strong>{state?.weatherFallback ? 'FALLBACK' : 'LIVE DATA'}</strong>
          </div>
        </div>

        <div className="map-footer-left"><span className="legend-dot normal" /> NORMAL <span className="legend-dot warning" /> REROUTING <span className="legend-dot critical" /> DISTRESS</div>
        <div className="map-scale" title="fleet.json defines no default restricted-zone geometry. Saved zones are loaded from the database.">
          <Compass size={13} /> {viewMode === '3D' ? '3D TILT VIEW' : '2D MERCATOR'}
          <span className="map-zone-count"><i /> {state?.zones.length || 0} RESTRICTED</span>
        </div>
      </section>

      <aside className="intel-panel">
        <div className="panel-heading"><span>ALERT CENTER</span><b className={activeAlerts.some(alert => alert.severity === 'CRITICAL') ? 'alert-count critical-count' : 'alert-count'}>{activeAlerts.length.toString().padStart(2, '0')}</b></div>
        <div className="alerts-list">
          {activeAlerts.slice(0, 5).map(alert => <article key={alert.id} className={`alert-card ${alert.severity.toLowerCase()}`}>
            <div className="alert-type"><TriangleAlert size={13} />{alert.type.replaceAll('_', ' ')}</div><p>{alert.message}</p>{alert.type === 'DISTRESS' && alert.metadata && <small className="distress-analysis">{alert.metadata.issue} · {alert.metadata.injuryCount} injured{alert.metadata.cargoDamagePercent == null ? '' : ` · ${alert.metadata.cargoDamagePercent}% cargo damage`} · {alert.metadata.source === 'ai' ? 'AI analyzed' : `local fallback${alert.metadata.fallbackReason ? ` · ${alert.metadata.fallbackReason}` : ''}`}</small>}
            {alert.status === 'ACTIVE' && <button onClick={() => emit('alert:ack', alert.id)}><Check size={12} /> ACKNOWLEDGE</button>}
          </article>)}
          {!activeAlerts.length && <div className="empty-state"><Activity size={17} /><span>NO ACTIVE INCIDENTS</span></div>}
        </div>

        {detailShip && <ShipCard ship={detailShip} command={role === 'COMMAND'} directive={() => issueDirective(detailShip)} />}
        {role === 'CAPTAIN' && selectedShip?.pendingDirective && <CaptainCard ship={selectedShip} disabled={!sessionReady}
          respond={(response, payload) => emit('directive:respond', { shipId: selectedShip.id, response, payload })} />}
        <div className="panel-footnote"><ScanLine size={13} /> TELEMETRY STREAM ACTIVE</div>
      </aside>
    </main>

    <footer className="statusbar">
      <div><span className={socket?.connected ? 'connection-light' : 'connection-light offline'} />
        {socket?.connected ? 'SYSTEMS CONNECTED' : 'CONNECTING TO FLEET'} <i />
        {state?.weatherFallback ? 'WEATHER FALLBACK' : 'WEATHER NOMINAL'}</div>
      <div className="playback-controls"><button disabled={!historyFrames.length} aria-label={playback === null ? 'Pause live view' : 'Resume live view'} onClick={() => setPlayback(playback === null ? 0 : null)}>
        {playback === null ? <Pause size={13} /> : <Play size={13} />}</button>
        <input aria-label="Fleet history playback" disabled={!historyFrames.length} type="range" min="0" max={Math.max(0, historyFrames.length - 1)} value={playback ?? Math.max(0, historyFrames.length - 1)}
          onChange={event => setPlayback(Number(event.target.value))} />
        <span>{!historyFrames.length ? 'HISTORY PENDING' : playback === null ? 'LIVE' : 'PLAYBACK'}</span></div>
    </footer>
    {toast && <button className="toast" onClick={() => setToast('')}>{toast}</button>}
  </div>;
}

function Metric({ number, label, active, onClick }: { number: number; label: string; active: boolean; onClick: () => void }) {
  return <button className={`metric${active ? ' active' : ''}`} aria-pressed={active} onClick={onClick}>
    <strong>{number.toString().padStart(2, '0')}</strong><span>{label}</span>
  </button>;
}

function ShipCard({ ship, command, directive }: { ship: ShipData; command: boolean; directive: () => void }) {
  const fuelPercent = Math.max(0, Math.min(100, ship.fuel / ship.fuelCapacityTons * 100));
  return <section className="vessel-card">
    <div className="vessel-card-heading"><span><ShipIcon size={14} /> VESSEL TELEMETRY</span><b style={{ color: statusColors[ship.status] || '#46e6a5' }}>{ship.status.replaceAll('_', ' ')}</b></div>
    <h2>{ship.name}</h2>
    <div className="vessel-coordinates">{coordinate(ship.latitude, 'lat')} <span>/</span> {coordinate(ship.longitude, 'lng')}</div>
    <div className="fuel-meter"><div><span>FUEL · {ship.fuel.toFixed(0)} t</span><b>{fuelPercent.toFixed(1)}%</b></div><i><b style={{ width: `${fuelPercent}%` }} /></i></div>
    <dl className="vessel-stats">
      <div><dt>SPEED</dt><dd>{(ship.speed / 1.852).toFixed(1)} kn</dd></div><div><dt>HEADING</dt><dd>{ship.heading.toFixed(0)}°</dd></div>
      <div><dt>DESTINATION</dt><dd>{ship.destination.name}</dd></div><div><dt>CARGO</dt><dd>{ship.cargo.type}</dd></div>
    </dl>
    {command && <button className="directive-button" onClick={directive}>ISSUE DIRECTIVE <ChevronRight size={14} /></button>}
  </section>;
}

function CaptainCard({ ship, respond, disabled }: { ship: ShipData; respond: (response: string, payload: any) => void; disabled: boolean }) {
  const [message, setMessage] = useState('');
  return <section className="captain-directive"><b>NEW DIRECTIVE · {ship.pendingDirective.type}</b>
    <p>Command has issued a course instruction for this vessel.</p>
    {!disabled && <p className="captain-assignment">ASSIGNED TO {ship.name.toUpperCase()}</p>}
    {disabled && <p className="captain-assignment">CONNECTING CAPTAIN SESSION…</p>}
    <button disabled={disabled} onClick={() => respond('ACCEPT', ship.pendingDirective.payload)}>ACCEPT</button>
    <textarea value={message} onChange={event => setMessage(event.target.value)} placeholder="Distress details if you cannot comply" />
    <button className="escalate" disabled={disabled} onClick={() => respond('ESCALATE_DISTRESS', { message })}>ESCALATE DISTRESS</button>
  </section>;
}

createRoot(document.getElementById('root')!).render(<App />);
