import { NextRequest, NextResponse } from "next/server";
import { builderFromRequest, logUsage } from "@/lib/builder/keys";
import { BedPlannerBody, planForPartner } from "@/lib/builder/engine/partner";

// POST /api/v1/bed-planner/plan — plan a cabin's beds over the open window.
// Stateless: send rooms, beds, stays and current assignments; get the plan,
// the moves and ready-to-send member notices. Nothing about members is kept.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const started = Date.now();
  const b = await builderFromRequest(req, "bed_planner");
  if (b instanceof NextResponse) return b;
  const parsed = BedPlannerBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    await logUsage(b, "bed-planner/plan", started, 0, [], 400);
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues.slice(0, 20) }, { status: 400 });
  }
  try {
    const { members, ...out } = planForPartner(parsed.data);
    await logUsage(b, "bed-planner/plan", started, out.assignments.length, members, 200, { cabin: parsed.data.cabin_id ?? null });
    return NextResponse.json(out);
  } catch (e) {
    console.error("[api/v1/bed-planner]", e);
    await logUsage(b, "bed-planner/plan", started, 0, [], 500);
    return NextResponse.json({ error: "plan_failed" }, { status: 500 });
  }
}
