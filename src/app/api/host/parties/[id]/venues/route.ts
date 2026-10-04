import { NextRequest, NextResponse } from "next/server";
import { db, type Party } from "@/lib/db";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { store } from "@/lib/store";
import { suggestVenue } from "@/lib/venues";
import { notifyHostOfVenue } from "@/lib/mail";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // web search takes a while

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  return NextResponse.json({ suggestions: await store.venueSuggestions(id) }, { headers: { "cache-control": "no-store" } });
}

// Runs the venue agent and notifies the host about its suggestion.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  try {
    const suggestion = await suggestVenue(id);
    const { data: party } = await db.from("parties").select("*").eq("id", id).single();
    const notice = await notifyHostOfVenue(party as Party, suggestion).catch((e) => ({ notified: "board_only" as const, error: (e as Error).message }));
    return NextResponse.json({ suggestion, notice }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
