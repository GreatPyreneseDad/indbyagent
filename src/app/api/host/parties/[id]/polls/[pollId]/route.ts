import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { unauthorized, forbidden, PollPatchBody, tallyRanked } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { parseBody } from "@/lib/http";

export const dynamic = "force-dynamic";

// PATCH {status:"closed"} closes a poll. For a "dates" poll, add {set_date:true}
// to write the ranked winner to the party's starts_at: the invite flips from
// "Date TBD" to a real date and the .ics starts working.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; pollId: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id, pollId } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const p = await parseBody(req, PollPatchBody);
  if ("res" in p) return p.res;
  const { data: poll } = await db.from("polls").select("*").eq("id", pollId).eq("party_id", id).maybeSingle();
  if (!poll) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data: rows } = await db.from("poll_state").select("choice,ranking").eq("poll_id", pollId).not("choice", "is", null);
  const tally = tallyRanked(poll.options, rows ?? []);
  let starts_at: string | null = null;
  if (p.data.set_date) {
    if (poll.kind !== "dates") return NextResponse.json({ error: "set_date only applies to a dates poll" }, { status: 400 });
    if (!tally.winner) return NextResponse.json({ error: "no rankings yet" }, { status: 409 });
    starts_at = tally.winner;
    await db.from("parties").update({ starts_at }).eq("id", id);
  }
  if (p.data.status) await db.from("polls").update({ status: p.data.status }).eq("id", pollId);
  return NextResponse.json({ poll: { ...poll, status: p.data.status ?? poll.status }, tally, starts_at });
}
