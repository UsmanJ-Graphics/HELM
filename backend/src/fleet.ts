const FUEL_CAPACITY_TONS = 10_000;
const KM_PER_KNOT = 1.852;

/** The supplied simplified water ring pinches shut at Hormuz. This narrow
 * operational connector restores the intended passage between the Gulf and
 * Gulf of Oman while preserving the original fleet boundary. GeoJSON order. */
const HORMUZ_CONNECTOR: [number, number][] = [
  [56.30, 26.48], [56.65, 26.48], [56.65, 26.30], [56.30, 26.30], [56.30, 26.48],
];

/** Convert the supplied Code Rush fleet data into the simulator's internal units. */
export function adaptFleet(source: any) {
  const ports = new Map(source.ports.map((port: any) => [port.id, port]));
  return {
    scenario: source.scenario,
    bbox: {
      minLat: source.boundingBox.south,
      maxLat: source.boundingBox.north,
      minLng: source.boundingBox.west,
      maxLng: source.boundingBox.east,
    },
    // The supplied polygon is [lat, lng]; Turf/GeoJSON uses [lng, lat].
    navigablePolygon: source.navigableWater.map(([lat, lng]: [number, number]) => [lng, lat]),
    navigablePolygons: [source.navigableWater.map(([lat, lng]: [number, number]) => [lng, lat]), HORMUZ_CONNECTOR],
    ships: source.fleet.map((ship: any) => {
      const port: any = ports.get(ship.destination);
      if (!port) throw new Error(`Unknown destination port ${ship.destination} for ${ship.name}`);
      const fuelTons = Number(ship.fuel);
      return {
        id: ship.shipId,
        name: ship.name,
        lat: ship.position[0],
        lng: ship.position[1],
        // Keep the source units available while adapting the engine to km/h.
        speed: Number(ship.speed) * KM_PER_KNOT,
        speedKnots: Number(ship.speed),
        heading: Number(ship.heading),
        destination: { id: port.id, name: port.name, lat: port.position[0], lng: port.position[1] },
        // The brief gives fuel in tons but no tank capacities; 10,000 tons is
        // the documented normalization assumption used for the percentage UI.
        fuel: fuelTons,
        fuelCapacityTons: FUEL_CAPACITY_TONS,
        cargo: { type: ship.cargo, amount: null },
        status: String(ship.status || 'normal').toUpperCase(),
      };
    }),
  };
}

export const FUEL_CAPACITY_TONS_ASSUMPTION = FUEL_CAPACITY_TONS;
export const KM_PER_KNOT_ASSUMPTION = KM_PER_KNOT;
