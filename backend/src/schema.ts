export const schemaSql = `
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS ships (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL, speed DOUBLE PRECISION NOT NULL, heading DOUBLE PRECISION NOT NULL, fuel_remaining DOUBLE PRECISION NOT NULL, destination JSONB NOT NULL, cargo JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS restricted_zones (id TEXT PRIMARY KEY, name TEXT NOT NULL, geometry geometry(POLYGON,4326) NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS restricted_zones_geometry_idx ON restricted_zones USING GIST(geometry);
CREATE TABLE IF NOT EXISTS ship_routes (id BIGSERIAL PRIMARY KEY, ship_id TEXT REFERENCES ships(id), geometry geometry(LINESTRING,4326), route_status TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS directives (id TEXT PRIMARY KEY, ship_id TEXT REFERENCES ships(id), type TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), responded_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, ship_id TEXT, type TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, metadata JSONB DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TIMESTAMPTZ DEFAULT now(), acknowledged_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS alerts_status_idx ON alerts(status);
CREATE TABLE IF NOT EXISTS distress_events (id TEXT PRIMARY KEY, ship_id TEXT REFERENCES ships(id), message TEXT NOT NULL, severity TEXT, issue TEXT, injury_count INTEGER, damage_estimate DOUBLE PRECISION, ai_analysis JSONB, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS ship_snapshots (id BIGSERIAL PRIMARY KEY, ship_id TEXT REFERENCES ships(id), timestamp TIMESTAMPTZ NOT NULL, latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL, speed DOUBLE PRECISION NOT NULL, heading DOUBLE PRECISION NOT NULL, fuel_remaining DOUBLE PRECISION NOT NULL, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ship_snapshots_time_idx ON ship_snapshots(timestamp);
CREATE TABLE IF NOT EXISTS weather_snapshots (id BIGSERIAL PRIMARY KEY, data JSONB NOT NULL, timestamp TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS system_events (id BIGSERIAL PRIMARY KEY, type TEXT NOT NULL, ship_id TEXT, payload JSONB NOT NULL, timestamp TIMESTAMPTZ DEFAULT now());
`;
