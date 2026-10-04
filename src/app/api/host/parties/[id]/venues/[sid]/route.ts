import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { parseBody } from "@/lib/http";
import { store } from "@/lib/store";

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
  const all = await store.venueSuggestions(id);
  const current = all.find((s) => s.id === sid);
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (current.status !== "pending") return NextResponse.json({ error: `already ${current.status}` }, { status: 409 });
  const status = p.data.decision === "confirm" ? "confirmed" : "rejected";
  // One confirmed venue per party: a new confirmation replaces the old one.
  if (status === "confirmed") for (const o of all.filter((x) => x.status === "confirmed")) await store.decideVenue(id, o.id, "rejected");
  const s = await store.decideVenue(id, sid, status);
  if (status === "confirmed" && s) {
    const notes = await store.planningNotes(id);
    await store.setPlanningNotes(id, { ...notes, venue: `${s.venue.name}, ${s.venue.address} (confirmed by host)` });
  }
  return NextResponse.json({ suggestion: s });
}
