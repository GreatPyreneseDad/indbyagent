import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { parseBody } from "@/lib/http";
import { loadPlanning, planTurn } from "@/lib/planner";
import { fallback } from "@/lib/fallback";

export const dynamic = "force-dynamic";

const PlannerBody = z.object({ text: z.string().trim().max(2000).optional() }).strict();

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  return NextResponse.json(await loadPlanning(id), { headers: { "cache-control": "no-store" } });
}

// POST {text} sends the host's message. POST {} with no history starts the chat.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const p = await parseBody(req, PlannerBody);
  if ("res" in p) return p.res;
  if (!p.data.text) {
    const current = await loadPlanning(id);
    if (current.messages.length) return NextResponse.json({ ...current, suggested_polls: [], find_venue: false, offline: fallback.claude });
  }
  try {
    return NextResponse.json(await planTurn(id, host.id, p.data.text));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
