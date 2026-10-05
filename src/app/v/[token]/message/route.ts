import { NextRequest, NextResponse } from "next/server";
import { VendorMessageBody, writeVendorMessage } from "@/lib/vendor-requests";
import { loadCtx, respondWithRequest, isForm } from "@/lib/vendor-http";
import { notFound, parseBody, idem } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await loadCtx(token);
  if (!ctx) return notFound();
  if (isForm(req)) {
    const f = await req.formData();
    const body = VendorMessageBody.safeParse({ text: String(f.get("text") ?? ""), by: { kind: "human" } });
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const r = await writeVendorMessage(ctx, body.data, { channel: "web", defaultKind: "human" });
    if ("error" in r) return NextResponse.json(r, { status: 400 });
    return NextResponse.redirect(new URL(`/v/${token}?saved=message`, req.url), 303);
  }
  const p = await parseBody(req, VendorMessageBody);
  if ("res" in p) return p.res;
  const r = await writeVendorMessage(ctx, p.data, { channel: "api", idempotency_key: idem(req), defaultKind: "agent" });
  if ("error" in r) return NextResponse.json(r, { status: 400 });
  return respondWithRequest(token);
}
