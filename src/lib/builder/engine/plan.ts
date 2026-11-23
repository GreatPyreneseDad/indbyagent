// Bed planner / carpool engine. MIT licensed (see LICENSE). Copyright (c) 2026 Christopher MacGregor / ROSE Corp.
// Bed Planner window planner: pure, no I/O. Shared by the club's own cabins
// (run.ts loads from Supabase) and the partner API (/api/v1/bed-planner/plan).
import { solveNight, type Bed, type Fixed, type Party, type Person } from "./solve";

const DAY = 864e5;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY);

export type PlanRes = {
  id: string; user_id: string; check_in: string; check_out: string; guest_count: number;
  move_pref: Party["movePref"]; share_with: string | null; created_at: string; claim_since: string | null;
  priority: number;
};
export type Assign = { id: string; night: string; object_id: string; reservation_id: string; user_id: string; guest_slot: number | null; source: string; locked: boolean; held_since: string };
export type Outage = { object_id: string; starts_on: string; ends_on: string };
export type BedRequest = { object_id: string; requested_at: string };
export type Planned = { night: string; person: Person; bedId: string; reason: string; heldSince: string; requested: boolean };
export type PlanInput = {
  from: string; to: string;                 // nights [from, to)
  beds: Bed[];                              // available beds, sorted
  outages: Outage[];
  reservations: PlanRes[];                  // confirmed stays touching the window
  current: Assign[];                        // assignments from the night before `from` through the window
  requests: Map<string, BedRequest>;        // reservation id -> requested bed
  avoid: Map<string, Set<string>>;          // user id -> users they must not share a room with
  lastPremium: Map<string, number>;         // user id -> ms of latest night in a premium room
  timeZone?: string;                        // for "requested on arrival day" (default America/Los_Angeles)
  nowIso?: string;                          // held_since for newly taken beds
};

export function planWindow(input: PlanInput): { plan: Planned[]; unplaced: { night: string; person: Person }[] } {
  const { from, to, beds: allBeds, outages, reservations: res, current: curRows, requests: reqBy, avoid, lastPremium } = input;
  const tz = input.timeZone ?? "America/Los_Angeles";
  const nowIso = input.nowIso ?? new Date().toISOString();
  const keyOf = (resId: string, slot: number | null) => `${resId}:${slot ?? 0}`;
  const userKey = (userId: string, slot: number | null) => `${userId}:${slot ?? 0}`; // continuity follows the person across back-to-back stays
  const existing = new Map(curRows.map((a) => [`${a.night}|${keyOf(a.reservation_id, a.guest_slot)}`, a]));

  const out: Planned[] = [];
  const flags: { night: string; person: Person }[] = [];
  let prevNight = new Map<string, { bedId: string; heldSince: string }>();
  for (const a of curRows.filter((a) => a.night === addDays(from, -1))) prevNight.set(userKey(a.user_id, a.guest_slot), { bedId: a.object_id, heldSince: a.held_since });

  for (let night = from; night < to; night = addDays(night, 1)) {
    const beds = allBeds.filter((b) => !outages.some((o) => o.object_id === b.id && o.starts_on <= night && o.ends_on >= night));
    const here = res.filter((r) => r.check_in <= night && r.check_out > night);
    const fixed: Fixed[] = [];
    const parties: Party[] = [];
    const used = new Set<string>();
    for (const r of here) {
      if (used.has(r.id)) continue;
      const partner = r.share_with ? here.find((o) => o.user_id === r.share_with && o.share_with === r.user_id && !used.has(o.id)) : undefined;
      const group = partner ? [r, partner].sort((a, b) => a.created_at.localeCompare(b.created_at)) : [r];
      group.forEach((g) => used.add(g.id));
      const people: Person[] = [
        ...group.map((g) => ({ key: keyOf(g.id, null), resId: g.id, userId: g.user_id, guestSlot: null })),
        ...group.flatMap((g) => Array.from({ length: g.guest_count }, (_, i) => ({ key: keyOf(g.id, i + 1), resId: g.id, userId: g.user_id, guestSlot: i + 1 }))),
      ];
      const prevBed = new Map<string, string>();
      let held = Infinity;
      for (const p of people) {
        const was = prevNight.get(userKey(p.userId, p.guestSlot));
        if (was) { prevBed.set(p.key, was.bedId); held = Math.min(held, Date.parse(was.heldSince)); }
        const a = existing.get(`${night}|${p.key}`);
        if (a?.locked) fixed.push({ person: p, bedId: a.object_id });
      }
      const lead = group[0], req = reqBy.get(lead.id) ?? (partner ? reqBy.get(partner.id) : undefined);
      const reqAt = req ? Date.parse(req.requested_at) : Infinity;
      parties.push({
        id: lead.id, people, members: group.length, guests: group.reduce((s, g) => s + g.guest_count, 0),
        priority: Math.max(...group.map((g) => g.priority)),
        claimedAt: Math.min(held, reqAt, Date.parse(lead.claim_since ?? lead.created_at)),   // edits keep their place in line
        movePref: lead.move_pref, requestedBed: req?.object_id ?? null,
        requestedOnArrival: !!req && new Date(req.requested_at).toLocaleDateString("en-CA", { timeZone: tz }) === lead.check_in,
        prevBed, recentPremiumAt: Math.max(...group.map((g) => lastPremium.get(g.user_id) ?? 0)),
        avoidUsers: new Set(group.flatMap((g) => [...(avoid.get(g.user_id) ?? [])])),
      });
    }
    const result = solveNight(beds, parties, fixed);
    const next = new Map<string, { bedId: string; heldSince: string }>();
    for (const p of result.placements) {
      const was = prevNight.get(userKey(p.person.userId, p.person.guestSlot));
      const cur = existing.get(`${night}|${p.person.key}`);
      const heldSince = was?.bedId === p.bedId ? was.heldSince : cur?.object_id === p.bedId ? cur.held_since : nowIso;
      out.push({ night, ...p, heldSince, requested: reqBy.get(p.person.resId)?.object_id === p.bedId });
      next.set(userKey(p.person.userId, p.person.guestSlot), { bedId: p.bedId, heldSince });
    }
    for (const u of result.unplaced) flags.push({ night, person: u });
    prevNight = next;
  }
  return { plan: out, unplaced: flags };
}

// Beds that changed for a person on a night, comparing the plan to what was assigned before.
export function movesOf(plan: Planned[], current: Assign[], from: string, to: string) {
  const before = new Map(current.filter((a) => a.night >= from && a.night < to)
    .map((a) => [`${a.night}|${a.reservation_id}:${a.guest_slot ?? 0}`, a.object_id]));
  return {
    before,
    moved: plan.filter((p) => p.reason !== "locked" && before.has(`${p.night}|${p.person.key}`) && before.get(`${p.night}|${p.person.key}`) !== p.bedId),
  };
}
