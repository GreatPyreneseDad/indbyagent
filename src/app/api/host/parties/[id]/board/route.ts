import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { unauthorized, forbidden, tallyRanked } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Everything the host board shows, in one call. No model involved.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const [party, guests, polls, pollState, messages, llm] = await Promise.all([
    db.from("parties").select("*").eq("id", id).single(),
    db.from("guest_state").select("*").eq("party_id", id).order("name"),
    db.from("polls").select("*").eq("party_id", id).order("created_at"),
    db.from("poll_state").select("*").eq("party_id", id),
    db.from("messages").select("*").eq("party_id", id).order("created_at", { ascending: false }).limit(50),
    db.from("llm_calls").select("input_tokens,cache_read_tokens,output_tokens").eq("party_id", id),
  ]);
  if (!party.data) return NextResponse.json({ error: "not found" }, { status: 404 });
  const g = guests.data ?? [];
  const tally = (polls.data ?? []).map((p) => {
    const rows = (pollState.data ?? []).filter((r) => r.poll_id === p.id && r.choice);
    const counts: Record<string, number> = Object.fromEntries(p.options.map((o: string) => [o, 0]));
    for (const r of rows) counts[r.choice] = (counts[r.choice] ?? 0) + 1;
    const ranked = p.kind === "dates" ? tallyRanked(p.options, rows) : undefined;
    return { ...p, counts, ranked, answers: rows.map((r) => ({ guest_id: r.guest_id, choice: r.choice, ranking: r.ranking, note: r.note, by_kind: r.by_kind, by_name: r.by_name, channel: r.channel })) };
  });
  const tokens = (llm.data ?? []).reduce((a, r) => ({ in: a.in + r.input_tokens, cached: a.cached + r.cache_read_tokens, out: a.out + r.output_tokens }), { in: 0, cached: 0, out: 0 });
  const summary = {
    invited: g.length,
    yes: g.filter((x) => x.status === "yes").length,
    no: g.filter((x) => x.status === "no").length,
    maybe: g.filter((x) => x.status === "maybe").length,
    needs_human: g.filter((x) => x.status === "needs_human").length,
    pending: g.filter((x) => !x.status || x.status === "pending").length,
    headcount: g.filter((x) => x.status === "yes").reduce((a, x) => a + (x.party_size ?? 1), 0),
    by_agent: g.filter((x) => x.by_kind === "agent").length,
    by_human: g.filter((x) => x.by_kind === "human").length,
  };
  return NextResponse.json({ party: party.data, summary, guests: g, polls: tally, messages: messages.data ?? [], tokens }, { headers: { "cache-control": "no-store" } });
}
