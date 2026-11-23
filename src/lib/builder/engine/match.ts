// Bed planner / carpool engine. MIT licensed (see LICENSE). Copyright (c) 2026 Christopher MacGregor / ROSE Corp.
// Carpool matcher: pure, deterministic, no I/O.
// Seats open requests in drivers' cars for one event.
//  - First come, first seated (request time), so nobody is bumped by a later ask.
//  - Never seats a rider with a driver or another rider they have a block with.
//  - Smallest pickup detour wins; then fill cars that already have riders
//    (fewer cars on the road); then the earlier departure.
//  - A rider who asked for a specific car gets it when it fits.
//  - Departure windows are respected when both sides gave times.

export type Offer = {
  id: string; driver_id: string; seats_total: number; seats_taken?: number;
  depart_area: string; depart_at?: string | null; status?: string;
};
export type Request = {
  id: string; rider_id: string; pickup_area: string; seats?: number;
  offer_id?: string | null; created_at?: string | null;
  depart_after?: string | null; depart_before?: string | null;
};
export type Match = { request_id: string; offer_id: string; rider_id: string; driver_id: string; seats: number; detour_minutes: number | null; reason: string };
export type Unmatched = { request_id: string; reason: string };
export type MatchOptions = { maxDetourMinutes?: number; allowUnknownAreas?: boolean };

export const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
export const areaKey = (a: string, b: string) => {
  const [x, y] = [norm(a), norm(b)].sort();
  return `${x}|${y}`;
};

export function matchCarpools(offers: Offer[], requests: Request[], blocks: [string, string][], minutes: Map<string, number>, opts: MatchOptions = {}) {
  const maxDetour = opts.maxDetourMinutes ?? 20;
  const blocked = new Set(blocks.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  const clash = (a: string, b: string) => a !== b && blocked.has(`${a}|${b}`);
  const cars = offers.filter((o) => !o.status || o.status === "open").map((o) => ({
    o, free: o.seats_total - (o.seats_taken ?? 0), people: [o.driver_id] as string[], riders: 0,
  }));
  const detour = (from: string, to: string): number | null => {
    if (norm(from) === norm(to)) return 0;
    const m = minutes.get(areaKey(from, to));
    return m === undefined ? null : m;
  };
  const inWindow = (r: Request, o: Offer) => {
    if (!o.depart_at) return true;
    const t = Date.parse(o.depart_at);
    if (r.depart_after && t < Date.parse(r.depart_after)) return false;
    if (r.depart_before && t > Date.parse(r.depart_before)) return false;
    return true;
  };
  const order = [...requests].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id));
  const matches: Match[] = [];
  const unmatched: Unmatched[] = [];
  for (const r of order) {
    const seats = r.seats ?? 1;
    let best: { car: (typeof cars)[number]; score: number; d: number | null; reason: string } | null = null;
    // Keep the most telling reason across cars: blocked > time window > too far > unknown area > full.
    let why = "no car has room", rank = 0;
    const because = (r: number, text: string) => { if (r > rank) { rank = r; why = text; } };
    for (const car of cars) {
      if (car.o.driver_id === r.rider_id) continue;
      if (car.free < seats) continue;
      if (car.people.some((p) => clash(p, r.rider_id))) { because(4, "the cars that fit have someone they blocked"); continue; }
      if (!inWindow(r, car.o)) { because(3, "no car leaves in their time window"); continue; }
      const d = detour(r.pickup_area, car.o.depart_area);
      if (d === null && !opts.allowUnknownAreas) { because(1, "no car departs near their pickup area"); continue; }
      if (d !== null && d > maxDetour) { because(2, `nearest car is more than ${maxDetour} min away`); continue; }
      let score = -(d ?? maxDetour) * 10;
      let reason = d === 0 ? "same area" : d === null ? "area distance unknown" : `${d} min from the driver`;
      if (r.offer_id === car.o.id) { score += 1000; reason = "the car they asked for"; }
      if (car.riders > 0) score += 15;                       // fill cars already going
      if (car.o.depart_at) score -= Date.parse(car.o.depart_at) / 3.6e12; // earlier departure, tie-break weight
      if (!best || score > best.score || (score === best.score && car.o.id < best.car.o.id)) best = { car, score, d, reason };
    }
    if (!best) { unmatched.push({ request_id: r.id, reason: why }); continue; }
    best.car.free -= seats; best.car.riders += 1; best.car.people.push(r.rider_id);
    matches.push({ request_id: r.id, offer_id: best.car.o.id, rider_id: r.rider_id, driver_id: best.car.o.driver_id, seats, detour_minutes: best.d, reason: best.reason });
  }
  return { matches, unmatched, cars: cars.map((c) => ({ offer_id: c.o.id, seats_left: c.free, riders: c.riders })) };
}
