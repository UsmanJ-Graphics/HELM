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
  destination: { name: string; lat: number; lng: number }; fuel: number; cargo: { type: string };
  status: string; route: Point[]; weather: any; pendingDirective?: any;
};
type AlertData = { id: string; type: string; severity: string; shipId: string | null; message: string; status: string; createdAt: number };
type FleetState = { ships: ShipData[]; zones: any[]; alerts: AlertData[]; events: any[]; weatherFallback: boolean };
type ViewMode = '2D' | '3D';

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

function MapFocus({ ship }: { ship: ShipData | undefined }) {
  const map = useMap();
  useEffect(() => {
    if (!ship) return;
    map.flyTo([ship.latitude, ship.longitude], Math.max(map.getZoom(), 8), { duration: 0.9 });
  }, [map, ship?.id]);
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

function DrawZone({ onComplete }: { onComplete: (points: Point[]) => void }) {
  const [points, setPoints] = useState<Point[]>([]);
  useMapEvents({
    click(event) { setPoints(current => [...current, { lat: event.latlng.lat, lng: event.latlng.lng }]); },
    dblclick() { if (points.length >= 3) { onComplete(points); setPoints([]); } },
  });
  return points.length ? <Polyline positions={points.map(point => [point.lat, point.lng])} pathOptions={{ color: '#ff626d', dashArray: '6 6' }} /> : null;
}

function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [state, setState] = useState<FleetState | null>(null);
  const [visualShips, setVisualShips] = useState<ShipData[]>([]);
  const [role, setRole] = useState<'COMMAND' | 'CAPTAIN'>('COMMAND');
  const [captain, setCaptain] = useState('ship-01');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('2D');
  const [drawing, setDrawing] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [playback, setPlayback] = useState<number | null>(null);
  const [toast, setToast] = useState('');
  const audio = useRef<AudioContext>();
  const priorShips = useRef<Map<string, ShipData>>(new Map());

  useEffect(() => {
    const connection = io(apiUrl, { transports: ['websocket'] });
    setSocket(connection);
    connection.on('fleet:state', (next: FleetState) => setState(next));
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
    socket?.emit('session:join', { role, shipId: role === 'CAPTAIN' ? captain : undefined });
  }, [socket, role, captain]);

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
        return {
          ...ship,
          latitude: old.latitude + (ship.latitude - old.latitude) * progress,
          longitude: old.longitude + (ship.longitude - old.longitude) * progress,
          heading: old.heading + (ship.heading - old.heading) * progress,
        };
      }));
      if (progress < 1) frame = requestAnimationFrame(animate);
      else priorShips.current = new Map(target.map(ship => [ship.id, ship]));
    };
    animate();
    return () => cancelAnimationFrame(frame);
  }, [state]);

  useEffect(() => {
    fetch(`${apiUrl}/api/history`).then(response => response.json()).then(result => setHistory(result.history || [])).catch(() => {});
  }, []);

  const ships = state?.ships || [];
  const selectedShip = ships.find(ship => ship.id === (selectedId || (role === 'CAPTAIN' ? captain : null)));
  const hoveredShip = ships.find(ship => ship.id === hoveredId);
  const detailShip = hoveredShip || selectedShip;
  const activeAlerts = state?.alerts.filter(alert => alert.status !== 'RESOLVED') || [];
  const normalCount = ships.filter(ship => ship.status === 'NORMAL').length;
  const reroutingCount = ships.filter(ship => ship.status === 'REROUTING').length;
  const playbackShips = useMemo(() => playback === null
    ? visualShips
    : history.filter(item => item.timestamp === history[playback]?.timestamp), [playback, visualShips, history]);

  const emit = (event: string, payload: any, done?: () => void) => {
    socket?.emit(event, payload, (response: any) => {
      if (!response?.ok) setToast(response?.error || 'Request rejected');
      else done?.();
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
  const startDrawing = () => setDrawing(value => !value);

  return <div className="shell" onPointerDown={enableAudio}>
    <header className="topbar">
      <div className="brand"><Anchor size={21} /><span>HELM</span><small>MARITIME OPERATIONS</small></div>
      <div className="top-status"><span className="live-dot" /> LIVE FEED <b>{ships.length} VESSELS</b></div>
      <div className="role-switch">
        <button className={role === 'COMMAND' ? 'active' : ''} onClick={() => setRole('COMMAND')}>COMMAND</button>
        <button className={role === 'CAPTAIN' ? 'active' : ''} onClick={() => setRole('CAPTAIN')}>CAPTAIN</button>
        {role === 'CAPTAIN' && <select value={captain} onChange={event => setCaptain(event.target.value)}>{ships.map(ship => <option key={ship.id} value={ship.id}>{ship.name}</option>)}</select>}
      </div>
    </header>

    <main className="workspace">
      <aside className="fleet-panel">
        <div className="panel-heading"><span>FLEET OVERVIEW</span><b>{ships.length.toString().padStart(2, '0')} / 15</b></div>
        <div className="metrics">
          <Metric number={normalCount} label="NORMAL" />
          <Metric number={reroutingCount} label="REROUTING" />
          <Metric number={activeAlerts.length} label="ALERTS" />
        </div>
        <div className="list-heading"><span>ACTIVE VESSELS</span><span>LIVE</span></div>
        <div className="ship-list">
          {ships.map(ship => <button key={ship.id}
            className={`ship-row${selectedShip?.id === ship.id ? ' selected' : ''}${hoveredId === ship.id ? ' hovered' : ''}`}
            onClick={() => setSelectedId(ship.id)} onMouseEnter={() => setHoveredId(ship.id)} onMouseLeave={() => setHoveredId(null)}>
            <i className="ship-dot" style={{ background: statusColors[ship.status] || '#46e6a5' }} />
            <span className="ship-row-copy"><strong>{ship.name}</strong><small>{ship.status.replaceAll('_', ' ')} · {ship.speed.toFixed(1)} kn</small></span>
            <ChevronRight size={14} />
          </button>)}
        </div>
      </aside>

      <section className={`map-wrap${viewMode === '3D' ? ' mode-3d' : ''}`}>
        <div className="map-surface">
          <MapContainer center={[26, 56]} zoom={7} zoomControl={false} preferCanvas>
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapEvents onCursor={setCursor} />
            <MapFocus ship={selectedShip} />
            <MapZoomControls />
            {drawing && <DrawZone onComplete={points => {
              const name = window.prompt('Restricted-zone name', 'Restricted zone');
              if (name) emit('zone:create', { name, polygon: points });
              setDrawing(false);
            }} />}
            {state?.zones.map(zone => <Polygon key={zone.id} positions={zone.polygon.map((point: Point) => [point.lat, point.lng])}
              pathOptions={{ color: '#ff626d', fillOpacity: 0.16 }} />)}
            {playbackShips.map(ship => <Marker key={ship.id} position={[ship.latitude, ship.longitude]}
              icon={shipIcon(ship, selectedShip?.id === ship.id)}
              eventHandlers={{ click: () => setSelectedId(ship.id), mouseover: () => setHoveredId(ship.id), mouseout: () => setHoveredId(null) }}>
              <Tooltip className="ship-tooltip-wrap" direction="top" offset={[0, -13]} opacity={1}>
                <div className="ship-tooltip"><strong>{ship.name}</strong><span>{ship.status.replaceAll('_', ' ')}</span>
                  <small>{ship.latitude.toFixed(4)}°, {ship.longitude.toFixed(4)}° · {ship.speed.toFixed(1)} kn</small></div>
              </Tooltip>
            </Marker>)}
            {selectedShip && selectedShip.route.length > 0 && <Polyline positions={selectedShip.route.map(point => [point.lat, point.lng])}
              pathOptions={{ color: '#39e69b', weight: 2, dashArray: '5 8', opacity: 0.9 }} />}
          </MapContainer>
        </div>

        <div className="map-toolbar">
          <div className="map-mode"><button className={viewMode === '2D' ? 'active' : ''} onClick={() => setViewMode('2D')}>2D</button>
            <button className={viewMode === '3D' ? 'active' : ''} onClick={() => setViewMode('3D')}>3D</button></div>
          {role === 'COMMAND' && <button className={`map-action${drawing ? ' cancel' : ''}`} onClick={startDrawing}>
            {drawing ? <X size={14} /> : <MapPin size={14} />}{drawing ? 'CANCEL ZONE' : 'DRAW RESTRICTED ZONE'}
          </button>}
          <span className="weather-state"><CloudLightning size={14} />{state?.weatherFallback ? 'SYNTHETIC WEATHER' : 'LIVE WEATHER'}</span>
        </div>

        <div className="map-readout">
          <div><span><Crosshair size={13} /> MAP CURSOR</span><strong>{cursor ? `${cursor.lat.toFixed(4)}°  ${cursor.lng.toFixed(4)}°` : 'MOVE OVER MAP'}</strong></div>
          <i />
          <div><span><ShipIcon size={13} /> {detailShip ? detailShip.name.toUpperCase() : 'FLEET POSITION'}</span>
            <strong>{detailShip ? `${coordinate(detailShip.latitude, 'lat')}  ${coordinate(detailShip.longitude, 'lng')}` : `${ships.length} TRACKED`}</strong></div>
        </div>

        <div className="map-footer-left"><span className="legend-dot normal" /> NORMAL <span className="legend-dot warning" /> REROUTING <span className="legend-dot critical" /> DISTRESS</div>
        <div className="map-scale"><Compass size={13} /> {viewMode === '3D' ? '3D TILT VIEW' : '2D MERCATOR'}</div>
      </section>

      <aside className="intel-panel">
        <div className="panel-heading"><span>ALERT CENTER</span><b className={activeAlerts.some(alert => alert.severity === 'CRITICAL') ? 'alert-count critical-count' : 'alert-count'}>{activeAlerts.length.toString().padStart(2, '0')}</b></div>
        <div className="alerts-list">
          {activeAlerts.slice(0, 5).map(alert => <article key={alert.id} className={`alert-card ${alert.severity.toLowerCase()}`}>
            <div className="alert-type"><TriangleAlert size={13} />{alert.type.replaceAll('_', ' ')}</div><p>{alert.message}</p>
            {alert.status === 'ACTIVE' && <button onClick={() => emit('alert:ack', alert.id)}><Check size={12} /> ACKNOWLEDGE</button>}
          </article>)}
          {!activeAlerts.length && <div className="empty-state"><Activity size={17} /><span>NO ACTIVE INCIDENTS</span></div>}
        </div>

        {detailShip && <ShipCard ship={detailShip} command={role === 'COMMAND'} directive={() => issueDirective(detailShip)} />}
        {role === 'CAPTAIN' && selectedShip?.pendingDirective && <CaptainCard ship={selectedShip}
          respond={(response, payload) => emit('directive:respond', { shipId: selectedShip.id, response, payload })} />}
        <div className="panel-footnote"><ScanLine size={13} /> TELEMETRY STREAM ACTIVE</div>
      </aside>
    </main>

    <footer className="statusbar">
      <div><span className={socket?.connected ? 'connection-light' : 'connection-light offline'} />
        {socket?.connected ? 'SYSTEMS CONNECTED' : 'CONNECTING TO FLEET'} <i />
        {state?.weatherFallback ? 'WEATHER FALLBACK' : 'WEATHER NOMINAL'}</div>
      <div className="playback-controls"><button aria-label={playback === null ? 'Pause live view' : 'Resume live view'} onClick={() => setPlayback(playback === null ? 0 : null)}>
        {playback === null ? <Pause size={13} /> : <Play size={13} />}</button>
        <input type="range" min="0" max={Math.max(0, history.length - 1)} value={playback ?? Math.max(0, history.length - 1)}
          onChange={event => setPlayback(Number(event.target.value))} />
        <span>{playback === null ? 'LIVE' : 'PLAYBACK'}</span></div>
    </footer>
    {toast && <button className="toast" onClick={() => setToast('')}>{toast}</button>}
  </div>;
}

function Metric({ number, label }: { number: number; label: string }) {
  return <div className="metric"><strong>{number.toString().padStart(2, '0')}</strong><span>{label}</span></div>;
}

function ShipCard({ ship, command, directive }: { ship: ShipData; command: boolean; directive: () => void }) {
  return <section className="vessel-card">
    <div className="vessel-card-heading"><span><ShipIcon size={14} /> VESSEL TELEMETRY</span><b style={{ color: statusColors[ship.status] || '#46e6a5' }}>{ship.status.replaceAll('_', ' ')}</b></div>
    <h2>{ship.name}</h2>
    <div className="vessel-coordinates">{coordinate(ship.latitude, 'lat')} <span>/</span> {coordinate(ship.longitude, 'lng')}</div>
    <div className="fuel-meter"><div><span>FUEL</span><b>{ship.fuel.toFixed(1)}%</b></div><i><b style={{ width: `${Math.max(0, Math.min(100, ship.fuel))}%` }} /></i></div>
    <dl className="vessel-stats">
      <div><dt>SPEED</dt><dd>{ship.speed.toFixed(1)} kn</dd></div><div><dt>HEADING</dt><dd>{ship.heading.toFixed(0)}°</dd></div>
      <div><dt>DESTINATION</dt><dd>{ship.destination.name}</dd></div><div><dt>CARGO</dt><dd>{ship.cargo.type}</dd></div>
    </dl>
    {command && <button className="directive-button" onClick={directive}>ISSUE DIRECTIVE <ChevronRight size={14} /></button>}
  </section>;
}

function CaptainCard({ ship, respond }: { ship: ShipData; respond: (response: string, payload: any) => void }) {
  const [message, setMessage] = useState('');
  return <section className="captain-directive"><b>NEW DIRECTIVE · {ship.pendingDirective.type}</b>
    <p>Command has issued a course instruction for this vessel.</p>
    <button onClick={() => respond('ACCEPT', ship.pendingDirective.payload)}>ACCEPT</button>
    <textarea value={message} onChange={event => setMessage(event.target.value)} placeholder="Distress details if you cannot comply" />
    <button className="escalate" onClick={() => respond('ESCALATE_DISTRESS', { message })}>ESCALATE DISTRESS</button>
  </section>;
}

createRoot(document.getElementById('root')!).render(<App />);
