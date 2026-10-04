import { NextRequest, NextResponse } from "next/server";
import { processInbound } from "@/lib/inbound";
import { safeEqual } from "@/lib/token";

export const dynamic = "force-dynamic";

// AgentMail -> here on message.received. Payload fields are snake_case and the
// sender is `from_` (from is reserved). We accept both spellings.
export async function POST(req: NextRequest) {
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
  if (secret) {
    const got = req.headers.get("x-webhook-secret") ?? new URL(req.url).searchParams.get("secret") ?? "";
    if (!safeEqual(got, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const evt = await req.json().catch(() => null);
  const type: string = evt?.event_type ?? evt?.type ?? "";
  const m = evt?.message ?? evt?.data?.message ?? evt?.data ?? evt ?? {};
  const inboxId: string | undefined = m.inbox_id ?? m.inboxId;
  if (!type.includes("received") || !inboxId) return NextResponse.json({ ok: true, ignored: type || "no inbox" });
  const r = await processInbound({
    inboxId,
    messageId: m.message_id ?? m.messageId,
    from: String(m.from_ ?? m.from ?? ""),
    subject: m.subject,
    text: m.extracted_text ?? m.extractedText ?? m.text,
  });
  return NextResponse.json({ ok: true, ...r });
}
