import { NextRequest, NextResponse } from "next/server";
import { builderFromRequest, CALLS_PER_HOUR, AI_PAIRS_PER_DAY } from "@/lib/builder/keys";
import { db } from "@/lib/db";

// GET /api/v1/me — check a key: scopes, limits, active members in the last 30 days.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const b = await builderFromRequest(req);
  if (b instanceof NextResponse) return b;
  const { data } = await db.rpc("builder_active_members", { p_host: b.hostId, p_since: new Date(Date.now() - 30 * 864e5).toISOString() });
  return NextResponse.json({
    scopes: b.scopes, api_version: "v1",
    limits: { calls_per_hour_per_key: CALLS_PER_HOUR, ai_area_pairs_per_day: AI_PAIRS_PER_DAY },
    active_members_30d: data ?? 0,
  });
}
