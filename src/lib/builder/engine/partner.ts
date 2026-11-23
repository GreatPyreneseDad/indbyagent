// Bed planner / carpool engine. MIT licensed (see LICENSE). Copyright (c) 2026 Christopher MacGregor / ROSE Corp.
import { z } from "zod";
import type { Bed } from "./solve";
import { addDays, movesOf, planWindow, type Assign, type BedRequest, type PlanRes } from "./plan";

// Partner request -> Bed Planner planner -> partner response. Ids are the partner's own, opaque.
const Id = z.string().min(1).max(128);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Ts = z.string().datetime({ offset: true });

export const BedPlannerBody = z.object({
  cabin_id: Id.optional(),
  timezone: z.string().max(64).default("America/Los_Angeles"),
  now: Ts.optional(),                                   // defaults to the current time
  freeze_hour: z.number().int().min(0).max(23).default(18),
  window_days: z.number().int().min(1).max(31).default(14),
  rooms: z.array(z.object({
    id: Id, name: z.string().max(120), premium: z.number().int().min(0).max(3).default(0),
    private_bath: z.boolean().default(false), sort: z.number().int().default(0), active: z.boolean().default(true),
  })).max(100),
  beds: z.array(z.object({
    id: Id, room_id: Id, name: z.string().max(120),
    type: z.enum(["king", "queen", "full", "pull_out", "single", "bunk_single"]).default("single"),
    capacity: z.number().int().min(1).max(4).default(1), sort: z.number().int().default(0), available: z.boolean().default(true),
  })).max(400),
  outages: z.array(z.object({ bed_id: Id, from: Day, to: Day })).max(2000).default([]),   // inclusive nights
  stays: z.array(z.object({
    id: Id, member_id: Id, check_in: Day, check_out: Day,
    guests: z.number().int().min(0).max(20).default(0),
    move_pref: z.enum(["stay_put", "flexible", "upgrade"]).default("flexible"),
    share_with_member_id: Id.nullish(),                 // couples: both stays name each other
    priority: z.number().int().min(0).max(9).default(0), // VIP = 1; only breaks ties
    booked_at: Ts, claim_since: Ts.nullish(),
    requested_bed: z.object({ bed_id: Id, requested_at: Ts }).nullish(),
    last_premium_night: Day.nullish(),                  // latest night this member slept in a premium room
  })).max(3000),
  assignments: z.array(z.object({                        // include the night before the window for continuity
    night: Day, stay_id: Id, guest_slot: z.number().int().min(1).max(20).nullish(), bed_id: Id,
    locked: z.boolean().default(false), held_since: Ts.nullish(),
  })).max(30000).default([]),
  blocks: z.array(z.tuple([Id, Id])).max(5000).default([]),
});
export type BedPlannerInput = z.infer<typeof BedPlannerBody>;

function localNow(nowMs: number, tz: string) {
  const s = new Date(nowMs).toLocaleString("sv-SE", { timeZone: tz });
  return { date: s.slice(0, 10), hour: Number(s.slice(11, 13)) };
}

export function planForPartner(b: BedPlannerInput) {
  const nowMs = b.now ? Date.parse(b.now) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const { date, hour } = localNow(nowMs, b.timezone);
  const from = hour >= b.freeze_hour ? addDays(date, 1) : date;
  const to = addDays(date, b.window_days);

  const rooms = new Map(b.rooms.filter((r) => r.active).map((r) => [r.id, r]));
  const beds: Bed[] = b.beds.filter((x) => x.available && rooms.has(x.room_id)).map((x) => {
    const r = rooms.get(x.room_id)!;
    return { id: x.id, roomId: r.id, roomName: r.name, premium: r.premium, privateBath: r.private_bath, type: x.type, name: x.name, capacity: x.capacity, sort: r.sort * 100 + x.sort };
  }).sort((a, c) => a.sort - c.sort);

  const stays = b.stays.filter((s) => s.check_in < to && s.check_out > addDays(from, -1) && s.check_out > s.check_in);
  const stayById = new Map(stays.map((s) => [s.id, s]));
  const reservations: PlanRes[] = stays.map((s) => ({
    id: s.id, user_id: s.member_id, check_in: s.check_in, check_out: s.check_out, guest_count: s.guests,
    move_pref: s.move_pref, share_with: s.share_with_member_id ?? null, created_at: s.booked_at, claim_since: s.claim_since ?? null, priority: s.priority,
  }));
  const current: Assign[] = b.assignments.filter((a) => stayById.has(a.stay_id) && a.night >= addDays(from, -1) && a.night < to).map((a, i) => ({
    id: `a${i}`, night: a.night, object_id: a.bed_id, reservation_id: a.stay_id, user_id: stayById.get(a.stay_id)!.member_id,
    guest_slot: a.guest_slot ?? null, source: "partner", locked: a.locked, held_since: a.held_since ?? nowIso,
  }));
  const requests = new Map<string, BedRequest>(stays.filter((s) => s.requested_bed).map((s) => [s.id, { object_id: s.requested_bed!.bed_id, requested_at: s.requested_bed!.requested_at }]));
  const avoid = new Map<string, Set<string>>();
  for (const [x, y] of b.blocks) for (const [p, q] of [[x, y], [y, x]]) { if (!avoid.has(p)) avoid.set(p, new Set()); avoid.get(p)!.add(q); }
  const lastPremium = new Map<string, number>();
  for (const s of stays) if (s.last_premium_night) lastPremium.set(s.member_id, Math.max(lastPremium.get(s.member_id) ?? 0, Date.parse(s.last_premium_night)));

  const { plan, unplaced } = planWindow({
    from, to, beds, outages: b.outages.map((o) => ({ object_id: o.bed_id, starts_on: o.from, ends_on: o.to })),
    reservations, current, requests, avoid, lastPremium, timeZone: b.timezone, nowIso,
  });
  const { before, moved } = movesOf(plan, current, from, to);
  const bedName = new Map(beds.map((x) => [x.id, `${x.roomName} · ${x.name}`]));

  // One notice per stay for the first night Bed Planner moved the member (not their guests, not their own pick).
  const notices: { member_id: string; stay_id: string; title: string; body: string }[] = [];
  const firstMove = new Map<string, typeof moved>();
  for (const m of moved) if (m.person.guestSlot === null && !m.requested) firstMove.set(m.person.resId, [...(firstMove.get(m.person.resId) ?? []), m]);
  for (const [stayId, ms] of firstMove) {
    const first = ms.sort((a, c) => a.night.localeCompare(c.night))[0];
    notices.push({ member_id: first.person.userId, stay_id: stayId, title: `Bed Planner moved you to ${bedName.get(first.bedId) ?? "another bed"}`,
      body: `From ${first.night}${ms.length > 1 ? ` (${ms.length} nights)` : ""}.` });
  }

  return {
    cabin_id: b.cabin_id ?? null,
    window: { from, to, frozen_before: from, timezone: b.timezone },
    assignments: plan.map((p) => ({
      night: p.night, stay_id: p.person.resId, member_id: p.person.userId, guest_slot: p.person.guestSlot, bed_id: p.bedId,
      reason: p.reason, held_since: p.heldSince, requested: p.requested, locked: p.reason === "locked",
    })),
    moves: moved.map((m) => ({ night: m.night, stay_id: m.person.resId, member_id: m.person.userId, guest_slot: m.person.guestSlot,
      from_bed: before.get(`${m.night}|${m.person.key}`) ?? null, to_bed: m.bedId, reason: m.reason })),
    unplaced: unplaced.map((u) => ({ night: u.night, stay_id: u.person.resId, member_id: u.person.userId, guest_slot: u.person.guestSlot })),
    notices,
    members: [...new Set(stays.map((s) => s.member_id))],
  };
}
