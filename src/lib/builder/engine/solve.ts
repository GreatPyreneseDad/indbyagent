// Bed planner / carpool engine. MIT licensed (see LICENSE). Copyright (c) 2026 Christopher MacGregor / ROSE Corp.
// Bed Planner solver: deterministic, one night at a time, no I/O.
//
// Rules:
//  - Squatter's rights: a person keeps the bed they hold unless a party that
//    fills beds better needs it. Party score = 2·members + guests, so
//    3 members > 2 members + guest > 2 members > member + guest > member > guest.
//  - VIP (bed_priority) only breaks ties; then whoever claimed first wins.
//  - When someone must give up a bed, the person who had a nice room most
//    recently gives it up first.
//  - Picks made on arrival day are sticky; frozen nights are never touched.
//  - Fewest moves: people stay in last night's bed unless they asked to upgrade.

export type Bed = { id: string; roomId: string; roomName: string; premium: number; privateBath: boolean; type: string; name: string; capacity: number; sort: number };
export type Person = { key: string; resId: string; userId: string; guestSlot: number | null };
export type Party = {
  id: string;                 // reservation id of the lead (couples merge into the earlier reservation)
  people: Person[];           // members first, then guests
  members: number;
  guests: number;
  priority: number;           // bed_priority (VIP = 1)
  claimedAt: number;          // ms: when they first held their current bed, or asked for one, or booked
  movePref: "stay_put" | "flexible" | "upgrade";
  requestedBed: string | null;
  requestedOnArrival: boolean;
  prevBed: Map<string, string>;     // person key -> bed they slept in last night (continuity)
  recentPremiumAt: number;          // ms of their latest night in a $/$$ room (0 = none)
  avoidUsers: Set<string>;          // block relations either way
};
export type Fixed = { person: Person; bedId: string };
export type Placement = { person: Person; bedId: string; reason: string };
export type NightResult = { placements: Placement[]; unplaced: Person[] };

const TYPE_RANK: Record<string, number> = { king: 5, queen: 4, full: 3, pull_out: 1, single: 1, bunk_single: 0 };
export function bedQuality(b: Bed) {
  const top = /top/i.test(b.name) ? -1 : 0;
  return b.premium * 10 + (b.privateBath ? 3 : 0) + (TYPE_RANK[b.type] ?? 1) + top;
}
export const partyScore = (p: Pick<Party, "members" | "guests">) => 2 * p.members + p.guests;

// Pack a party into bed-sized units: pairs share a 2-person bed, an odd person sleeps alone.
function units(people: Person[]): Person[][] {
  const out: Person[][] = [];
  for (let i = 0; i < people.length; i += 2) out.push(people.slice(i, i + 2));
  return out;
}

export function solveNight(beds: Bed[], parties: Party[], fixed: Fixed[]): NightResult {
  const taken = new Map<string, number>();       // bed -> people in it
  const bedOccupants = new Map<string, string[]>(); // bed -> userIds (for blocks)
  const roomUsers = new Map<string, Set<string>>();
  const bedById = new Map(beds.map((b) => [b.id, b]));
  const placements: Placement[] = [];
  const unplaced: Person[] = [];
  const put = (person: Person, bedId: string, reason: string) => {
    taken.set(bedId, (taken.get(bedId) ?? 0) + 1);
    bedOccupants.set(bedId, [...(bedOccupants.get(bedId) ?? []), person.userId]);
    const room = bedById.get(bedId)!.roomId;
    if (!roomUsers.has(room)) roomUsers.set(room, new Set());
    roomUsers.get(room)!.add(person.userId);
    placements.push({ person, bedId, reason });
  };
  for (const f of fixed) if (bedById.has(f.bedId)) put(f.person, f.bedId, "locked");
  const fixedKeys = new Set(fixed.map((f) => f.person.key));

  // Who currently "holds" each bed (from last night) — used to decide who yields.
  const holder = new Map<string, Party>();
  for (const p of parties) for (const b of p.prevBed.values()) if (!holder.has(b)) holder.set(b, p);

  const order = [...parties].sort((a, b) =>
    partyScore(b) - partyScore(a) || b.priority - a.priority || a.claimedAt - b.claimedAt || a.id.localeCompare(b.id));

  for (const party of order) {
    const todo = party.people.filter((p) => !fixedKeys.has(p.key));
    if (!todo.length) continue;
    const myRooms = new Set<string>();
    for (const unit of units(todo)) {
      let best: { bed: Bed; score: number; reason: string } | null = null;
      for (const bed of beds) {
        const used = taken.get(bed.id) ?? 0;
        if (used > 0 || bed.capacity < unit.length) continue;   // no strangers sharing a bed
        let score = bedQuality(bed) * 10, reason = "best open bed";
        const prev = unit.map((u) => party.prevBed.get(u.key)).find(Boolean);
        if (prev === bed.id) {
          const w = party.movePref === "stay_put" ? 10000 : party.movePref === "upgrade" ? 30 : 600;
          score += w; reason = "same bed as last night";
        }
        if (party.requestedBed === bed.id) { score += party.requestedOnArrival ? 900 : 350; reason = "the bed they asked for"; }
        if (myRooms.has(bed.roomId)) score += 40;
        if (unit.length === 1 && bed.capacity > 1) score -= 15;   // keep doubles for pairs
        const h = holder.get(bed.id);
        if (h && h !== party) {
          // Taking someone's bed: cheaper when they had a nice room recently, dearer if they picked it on arrival day.
          score -= h.requestedOnArrival && h.requestedBed === bed.id ? 700 : 220;
          if (h.recentPremiumAt) score += 60;
        }
        const roomPeople = roomUsers.get(bed.roomId);
        if (roomPeople && [...roomPeople].some((u) => party.avoidUsers.has(u))) score -= 5000;
        if (!best || score > best.score || (score === best.score && bed.sort < best.bed.sort)) best = { bed, score, reason };
      }
      if (!best) { unplaced.push(...unit); continue; }
      for (const person of unit) put(person, best.bed.id, best.reason);
      myRooms.add(best.bed.roomId);
    }
  }
  return { placements, unplaced };
}
