import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { builderFromRequest, logUsage, aiPairsToday, AI_PAIRS_PER_DAY } from "@/lib/builder/keys";
import { matchCarpools, areaKey } from "@/lib/builder/engine/match";
import { areaMinutes } from "@/lib/builder/areas";

// POST /api/v1/carpool/match — seat riders in drivers' cars for one event.
// Areas are neighborhoods, never addresses. Unknown pairs can be estimated by
// AI (cached per region, daily cap per builder).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Id = z.string().min(1).max(128);
const Ts = z.string().datetime({ offset: true });
const Area = z.string().min(1).max(80);
const Body = z.object({
  event_id: Id.optional(),
  region: z.string().max(120).default(""),
  max_detour_minutes: z.number().int().min(0).max(120).default(20),
  estimate_unknown_areas: z.boolean().default(true),
  allow_unknown_areas: z.boolean().default(false),
  offers: z.array(z.object({
    id: Id, driver_id: Id, seats_total: z.number().int().min(1).max(8), seats_taken: z.number().int().min(0).max(8).default(0),
    depart_area: Area, depart_at: Ts.nullish(), status: z.enum(["open", "full", "closed", "canceled"]).default("open"),
  })).max(300),
  requests: z.array(z.object({
    id: Id, rider_id: Id, pickup_area: Area, seats: z.number().int().min(1).max(4).default(1),
    offer_id: Id.nullish(), created_at: Ts.nullish(), depart_after: Ts.nullish(), depart_before: Ts.nullish(),
  })).max(1000),
  blocks: z.array(z.tuple([Id, Id])).max(5000).default([]),
  area_minutes: z.array(z.object({ a: Area, b: Area, minutes: z.number().int().min(0).max(999) })).max(5000).default([]),
});

export async function POST(req: NextRequest) {
  const started = Date.now();
  const bld = await builderFromRequest(req, "carpool");
  if (bld instanceof NextResponse) return bld;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    await logUsage(bld, "carpool/match", started, 0, [], 400);
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues.slice(0, 20) }, { status: 400 });
  }
  const b = parsed.data;
  try {
    const given = new Map(b.area_minutes.map((m) => [areaKey(m.a, m.b), m.minutes]));
    const open = b.offers.filter((o) => o.status === "open");
    const pairs: [string, string][] = [];
    for (const r of b.requests) for (const o of open) if (!given.has(areaKey(r.pickup_area, o.depart_area))) pairs.push([r.pickup_area, o.depart_area]);
    const budget = b.estimate_unknown_areas && b.region ? Math.max(0, AI_PAIRS_PER_DAY - (await aiPairsToday(bld.hostId))) : 0;
    const { minutes: cached, estimated, warning } = await areaMinutes(b.region, pairs, { estimate: budget > 0, budget });
    const minutes = new Map([...cached, ...given]);
    const out = matchCarpools(b.offers, b.requests, b.blocks, minutes, { maxDetourMinutes: b.max_detour_minutes, allowUnknownAreas: b.allow_unknown_areas });
    const used = [...new Set(out.matches.map((m) => {
      const r = b.requests.find((x) => x.id === m.request_id)!, o = b.offers.find((x) => x.id === m.offer_id)!;
      return areaKey(r.pickup_area, o.depart_area);
    }))].filter((k) => minutes.has(k)).map((k) => ({ pair: k, minutes: minutes.get(k)!, source: given.has(k) ? "builder" : "ai" }));
    await logUsage(bld, "carpool/match", started, out.matches.length, [...b.offers.map((o) => o.driver_id), ...b.requests.map((r) => r.rider_id)], 200, { event: b.event_id ?? null, estimated });
    return NextResponse.json({ event_id: b.event_id ?? null, ...out, area_minutes_used: used, areas_estimated: estimated, ...(warning ? { warning } : {}) });
  } catch (e) {
    console.error("[api/v1/carpool]", e);
    await logUsage(bld, "carpool/match", started, 0, [], 500);
    return NextResponse.json({ error: "match_failed" }, { status: 500 });
  }
}
