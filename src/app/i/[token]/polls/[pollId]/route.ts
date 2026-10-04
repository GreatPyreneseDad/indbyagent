import { NextRequest, NextResponse } from "next/server";
import { loadInvite, PollBody, writePollAnswer } from "@/lib/invite";
import { notFound, parseBody, respondWithInvite, idem } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string; pollId: string }> }) {
  const { token, pollId } = await params;
  const ctx = await loadInvite(token);
  if (!ctx) return notFound();
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("form")) {
    const f = await req.formData();
    const poll = ctx.polls.find((p) => p.id === pollId);
    // Ranked date polls post rank_<option index> = 1..n, blank for "can't make it".
    const ranking = poll?.kind === "date_rank"
      ? poll.options.map((o, i) => ({ o, r: Number(f.get(`rank_${i}`)) })).filter((x) => x.r > 0).sort((a, b) => a.r - b.r).map((x) => x.o)
      : undefined;
    if (ranking && !ranking.length) return NextResponse.redirect(new URL(`/i/${token}?error=rank`, req.url), 303);
    const body = PollBody.safeParse({ choice: ranking ? undefined : f.get("choice"), ranking, note: String(f.get("note") ?? ""), by: { kind: "human" } });
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const r = await writePollAnswer(ctx, pollId, body.data, { channel: "web", defaultKind: "human" });
    if ("error" in r) return NextResponse.json(r, { status: 400 });
    return NextResponse.redirect(new URL(`/i/${token}?saved=1`, req.url), 303);
  }
  const p = await parseBody(req, PollBody);
  if ("res" in p) return p.res;
  const r = await writePollAnswer(ctx, pollId, p.data, { channel: "api", idempotency_key: idem(req), defaultKind: "agent" });
  if ("error" in r) return NextResponse.json(r, { status: 400 });
  return respondWithInvite(token);
}
