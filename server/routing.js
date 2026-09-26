// routing.js — "deflect around obstacles" pathfinder.
//
// Documented assumption (per spec: "routing algorithm is up to you"):
// Restricted zones (operator-drawn polygons) and severe-weather cells are both
// approximated as circles (bounding circle of the polygon / storm cell) for
// path computation. This keeps the algorithm simple and fast enough to run
// every tick for 15 ships, at the cost of hugging zone boundaries a bit
// loosely on very irregular polygon shapes.

const {
  haversineKm,
  bearing,
  destinationPoint,
  boundingCircle,
  segmentIntersectsCircle,
} = require('./geo');

const MAX_DEFLECTIONS = 6;
const ZONE_BUFFER_KM = 1.0; // safety margin added around every obstacle

function findBlocking(a, b, obstacles) {
  for (const obs of obstacles) {
    if (segmentIntersectsCircle(a, b, obs)) return obs;
  }
  return null;
}

function detourWaypoint(current, dest, circle) {
  const buffer = circle.radiusKm + ZONE_BUFFER_KM;
  const brng = bearing(current, dest);
  const leftBrng = (brng - 90 + 360) % 360;
  const rightBrng = (brng + 90) % 360;
  const left = destinationPoint(circle, leftBrng, buffer);
  const right = destinationPoint(circle, rightBrng, buffer);
  // Pick the side that makes more progress toward the destination.
  return haversineKm(left, dest) <= haversineKm(right, dest) ? left : right;
}

/**
 * Compute a route from `start` to `dest`, avoiding `zones` (restricted areas)
 * and `stormCells` (adverse-weather circles). Returns:
 *   { path: [{lat,lng}, ...], feasible: bool, distanceKm: number }
 */
function computeRoute(start, dest, zones = [], stormCells = []) {
  const obstacles = [
    ...zones.map((z) => ({ ...boundingCircle(z.polygon), zoneId: z.id, kind: 'zone' })),
    ...stormCells.map((s) => ({ ...s, kind: 'weather' })),
  ];

  let path = [start];
  let current = start;
  let feasible = true;

  for (let i = 0; i < MAX_DEFLECTIONS; i++) {
    const blocking = findBlocking(current, dest, obstacles);
    if (!blocking) {
      path.push(dest);
      break;
    }
    const wp = detourWaypoint(current, dest, blocking);
    path.push(wp);
    current = wp;
    if (i === MAX_DEFLECTIONS - 1) {
      // Still blocked after max deflections — check if truly boxed in.
      const stillBlocking = findBlocking(current, dest, obstacles);
      if (stillBlocking) feasible = false;
      path.push(dest);
    }
  }

  // If start itself sits inside a *zone* (not weather), that's a breach, not
  // an unreachable path — caller handles the alert; routing still proceeds.
  let distanceKm = 0;
  for (let i = 1; i < path.length; i++) distanceKm += haversineKm(path[i - 1], path[i]);

  return { path, feasible, distanceKm };
}

module.exports = { computeRoute, detourWaypoint };
