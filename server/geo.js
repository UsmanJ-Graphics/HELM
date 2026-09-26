// geo.js — small geospatial helpers, no external deps.
// All angles in degrees, distances in km unless noted.

const R_EARTH_KM = 6371;

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

// Great-circle distance between two lat/lng points (Haversine).
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing from a -> b, in degrees (0 = north, clockwise).
function bearing(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Destination point given start, bearing (deg), distance (km).
function destinationPoint(start, bearingDeg, distKm) {
  const lat1 = toRad(start.lat);
  const lng1 = toRad(start.lng);
  const brng = toRad(bearingDeg);
  const dR = distKm / R_EARTH_KM;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brng)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(dR) * Math.cos(lat1),
      Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

// Ray-casting point-in-polygon. polygon = [[lng,lat], ...]
function pointInPolygon(point, polygon) {
  const x = point.lng, y = point.lat;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Bounding circle {lat,lng,radiusKm} of a polygon [[lng,lat],...] — used to
// approximate zone avoidance cheaply (documented simplification, see README).
function boundingCircle(polygon) {
  let sumLat = 0, sumLng = 0;
  polygon.forEach(([lng, lat]) => { sumLat += lat; sumLng += lng; });
  const center = { lat: sumLat / polygon.length, lng: sumLng / polygon.length };
  let maxR = 0;
  polygon.forEach(([lng, lat]) => {
    const d = haversineKm(center, { lat, lng });
    if (d > maxR) maxR = d;
  });
  return { ...center, radiusKm: maxR };
}

// Does the segment a->b pass within radiusKm of center? (closest-approach test)
function segmentIntersectsCircle(a, b, circle) {
  const segLenKm = haversineKm(a, b);
  if (segLenKm < 1e-6) return haversineKm(a, circle) <= circle.radiusKm;
  const steps = Math.max(4, Math.ceil(segLenKm / 2)); // sample every ~2km
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const brng = bearing(a, b);
    const p = destinationPoint(a, brng, segLenKm * t);
    if (haversineKm(p, circle) <= circle.radiusKm) return true;
  }
  return false;
}

module.exports = {
  haversineKm,
  bearing,
  destinationPoint,
  pointInPolygon,
  boundingCircle,
  segmentIntersectsCircle,
  toRad,
  toDeg,
};
