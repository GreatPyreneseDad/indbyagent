import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { parseBody } from "@/lib/http";
import { store } from "@/lib/store";
import { decideSuggestion } from "@/lib/vendors";

export const dynamic = "force-dynamic";

const DecisionBody = z.object({ decision: z.enum(["confirm", "reject"]) }).strict();

// The host confirms or rejects a suggestion. A confirmed venue becomes the
// "venue" planning note so the planning chat knows about it.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id, sid } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const p = await parseBody(req, DecisionBody);
  if ("res" in p) return p.res;
  const status = p.data.decision === "confirm" ? "confirmed" : "rejected";
  try {
    const s = await decideSuggestion(id, host.id, sid, status);
    if ("error" in s) return NextResponse.json(s, { status: s.error === "not found" ? 404 : 409 });
    if (status === "confirmed") {
      const notes = await store.planningNotes(id);
      await store.setPlanningNotes(id, { ...notes, venue: `${s.venue.name}, ${s.venue.address} (confirmed by host)` });
    }
    return NextResponse.json({ suggestion: s });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
