import { NextRequest, NextResponse } from "next/server";
import { QuoteBody, writeQuote } from "@/lib/vendor-requests";
import { loadCtx, respondWithRequest, isForm } from "@/lib/vendor-http";
import { notFound, parseBody, idem } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await loadCtx(token);
  if (!ctx) return notFound();
  if (isForm(req)) {
    const f = await req.formData();
    const body = QuoteBody.safeParse({ price: Number(f.get("price")), currency: String(f.get("currency") || "usd"), available: f.get("available"), lead_time_days: f.get("lead_time_days") ? Number(f.get("lead_time_days")) : undefined, notes: String(f.get("notes") ?? "") || undefined, by: { kind: "human" } });
    if (!body.success) return NextResponse.json({ error: "invalid", issues: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
    const r = await writeQuote(ctx, body.data, { channel: "web", defaultKind: "human" });
    if ("error" in r) return NextResponse.json(r, { status: 400 });
    return NextResponse.redirect(new URL(`/v/${token}?saved=quote`, req.url), 303);
  }
  const p = await parseBody(req, QuoteBody);
  if ("res" in p) return p.res;
  const r = await writeQuote(ctx, p.data, { channel: "api", idempotency_key: idem(req), defaultKind: "agent" });
  if ("error" in r) return NextResponse.json(r, { status: 400 });
  return respondWithRequest(token);
}
