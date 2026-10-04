import { NextRequest, NextResponse } from "next/server";
import { loadInvite, MessageBody, writeMessage } from "@/lib/invite";
import { notFound, parseBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await loadInvite(token);
  if (!ctx) return notFound();
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("form")) {
    const f = await req.formData();
    const body = MessageBody.safeParse({ text: f.get("text"), by: { kind: "human" } });
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    await writeMessage(ctx, body.data, { channel: "web", defaultKind: "human" });
    return NextResponse.redirect(new URL(`/i/${token}?sent=1`, req.url), 303);
  }
  const p = await parseBody(req, MessageBody);
  if ("res" in p) return p.res;
  const r = await writeMessage(ctx, p.data, { channel: "api", defaultKind: "agent" });
  if ("error" in r) return NextResponse.json(r, { status: 400 });
  return NextResponse.json({ ok: true, note: "Delivered to the host. Replies arrive by email or on this invite." });
}
