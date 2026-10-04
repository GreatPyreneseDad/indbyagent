import { NextRequest, NextResponse } from "next/server";
import { db, type Party, type Poll } from "@/lib/db";
import { mail } from "@/lib/mail";
import { fastParse, llmParse } from "@/lib/parse";
import { safeEqual } from "@/lib/token";

export const dynamic = "force-dynamic";

// AgentMail -> here on message.received. Match the sender to a guest of the
// inbox's party, parse the new text, write RSVP / poll answers / question.
export async function POST(req: NextRequest) {
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
  if (secret) {
    const got = req.headers.get("x-webhook-secret") ?? new URL(req.url).searchParams.get("secret") ?? "";
    if (!safeEqual(got, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const evt = await req.json().catch(() => null);
  const type: string = evt?.type ?? evt?.event_type ?? "";
  const m = evt?.message ?? evt?.data?.message ?? evt?.data ?? evt;
  if (!type.includes("received") && !m?.inboxId) return NextResponse.json({ ok: true, ignored: type });
  const inboxId: string = m.inboxId ?? m.inbox_id;
  const messageId: string = m.messageId ?? m.message_id;
  const from: string = (m.from ?? "").toString();
  const fromEmail = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

  const { data: party } = await db.from("parties").select("*").eq("inbox_address", inboxId).maybeSingle();
  if (!party) return NextResponse.json({ ok: true, ignored: "no party for inbox" });
  const { data: guest } = await db.from("guests").select("id,name,email,party_size_max").eq("party_id", party.id).ilike("email", fromEmail).maybeSingle();

  // Prefer the stripped reply text; fall back to the full message.
  let text: string = m.extractedText ?? m.text ?? "";
  if (!text && messageId) {
    const full = await mail.inboxes.messages.get(inboxId, messageId).catch(() => null);
    text = full?.extractedText ?? full?.text ?? "";
  }
  text = text.replace(/\r/g, "").trim();
  if (!guest) {
    await db.from("review_queue").insert({ party_id: party.id, raw_text: `${from}: ${text}`.slice(0, 4000), reason: "sender not a guest" });
    return NextResponse.json({ ok: true, queued: "unknown sender" });
  }
  await db.from("messages").insert({ party_id: party.id, guest_id: guest.id, direction: "in", text: text.slice(0, 2000), by_kind: "human", channel: "email" });

  const { data: polls } = await db.from("polls").select("*").eq("party_id", party.id).eq("status", "open");
  const openPolls = (polls ?? []) as Poll[];
  let parsed = fastParse(text, openPolls);
  if (!parsed) parsed = await llmParse({ text, guestName: guest.name, partySizeMax: guest.party_size_max, polls: openPolls, partyId: party.id, purpose: "email_reply" });

  if (parsed.confidence < 0.6 || (!parsed.rsvp && !parsed.poll_answers?.length && !parsed.question)) {
    await db.from("review_queue").insert({ party_id: party.id, guest_id: guest.id, raw_text: text.slice(0, 4000), parse: parsed, reason: parsed.confidence < 0.6 ? "low confidence" : "nothing extracted" });
    return NextResponse.json({ ok: true, queued: true, source: parsed.source });
  }
  const written: string[] = [];
  if (parsed.rsvp) {
    const size = parsed.rsvp.party_size ?? (parsed.rsvp.status === "yes" ? 1 : 0);
    await db.from("rsvps").insert({ guest_id: guest.id, status: parsed.rsvp.status, party_size: Math.min(size, guest.party_size_max), dietary: parsed.rsvp.dietary ?? [], note: parsed.rsvp.note ?? null, by_kind: "human", by_name: guest.name, channel: "email", idempotency_key: messageId ?? null });
    written.push("rsvp");
  }
  for (const a of parsed.poll_answers ?? []) {
    await db.from("poll_answers").insert({ poll_id: a.poll_id, guest_id: guest.id, choice: a.choice, by_kind: "human", by_name: guest.name, channel: "email", idempotency_key: messageId ? `${messageId}:${a.poll_id}` : null });
    written.push("poll");
  }
  if (parsed.question) {
    await db.from("review_queue").insert({ party_id: party.id, guest_id: guest.id, raw_text: parsed.question, parse: parsed, reason: "question for host" });
    written.push("question");
  }
  return NextResponse.json({ ok: true, written, source: parsed.source, confidence: parsed.confidence });
}
