const KILOMETERS_PER_KNOT = 1.852;
const FUEL_CAPACITY_TONS = 10_000;

module.exports = function adaptFleet(source) {
  const ports = new Map(source.ports.map((port) => [port.id, port]));
  return {
    bbox: {
      minLat: source.boundingBox.south,
      maxLat: source.boundingBox.north,
      minLng: source.boundingBox.west,
      maxLng: source.boundingBox.east,
    },
    navigablePolygon: source.navigableWater.map(([lat, lng]) => [lng, lat]),
    ships: source.fleet.map((ship) => {
      const port = ports.get(ship.destination);
      if (!port) throw new Error(`Unknown destination port ${ship.destination} for ${ship.name}`);
      return {
        id: ship.shipId,
        name: ship.name,
        lat: ship.position[0],
        lng: ship.position[1],
        speed: Number(ship.speed) * KILOMETERS_PER_KNOT,
        heading: Number(ship.heading),
        destination: { id: port.id, name: port.name, lat: port.position[0], lng: port.position[1] },
        fuel: Math.max(0, Math.min(100, Number(ship.fuel) / FUEL_CAPACITY_TONS * 100)),
        cargo: { type: ship.cargo, amount: null },
        status: String(ship.status || 'normal').toLowerCase(),
      };
    }),
  };
};
