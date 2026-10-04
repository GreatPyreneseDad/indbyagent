import { db, type Poll } from "./db";
import { mail } from "./mail";
import { fastParse, llmParse } from "./parse";

// Process one inbound email for a party inbox. Shared by the AgentMail webhook
// and the host board's inbox sync. Idempotent per message_id.
export async function processInbound(opts: { inboxId: string; messageId: string; from: string; subject?: string; text?: string }) {
  const { inboxId, messageId } = opts;
  const fromEmail = (opts.from.match(/<([^>]+)>/)?.[1] ?? opts.from).trim().toLowerCase();
  // An inbox may be shared by several parties: route by the sender's guest
  // record, then by the party title in the subject line.
  const { data: parties } = await db.from("parties").select("*").eq("inbox_address", inboxId);
  if (!parties?.length) return { ignored: "no party for inbox" };
  const ids = parties.map((p) => p.id);
  const { data: seen } = await db.from("messages").select("id").in("party_id", ids).eq("direction", "in").eq("channel", "email").like("text", `%[mid:${messageId}]%`).limit(1);
  if (seen?.length) return { ignored: "duplicate" };
  const { data: matches } = await db.from("guests").select("id,name,email,party_size_max,party_id,created_at").in("party_id", ids).ilike("email", fromEmail).order("created_at", { ascending: false });
  const subject = (opts.subject ?? "").toLowerCase();
  const bySubject = parties.filter((p) => subject && subject.includes(String(p.title).toLowerCase()));
  const guest = (matches ?? []).find((g) => bySubject.some((p) => p.id === g.party_id)) ?? matches?.[0] ?? null;
  const party = guest ? parties.find((p) => p.id === guest.party_id)! : bySubject[0] ?? (parties.length === 1 ? parties[0] : null);
  if (!party) return { ignored: "cannot attribute sender to a party" };

  let text = opts.text ?? "";
  if (!text) {
    const full = await mail.inboxes.messages.get(inboxId, messageId).catch(() => null);
    text = full?.extractedText ?? full?.text ?? "";
  }
  text = text.replace(/\r/g, "").trim();
  if (!guest) {
    await db.from("review_queue").insert({ party_id: party.id, raw_text: `${opts.from}: ${text}`.slice(0, 4000), reason: "sender not a guest" });
    return { queued: "unknown sender" };
  }
  await db.from("messages").insert({ party_id: party.id, guest_id: guest.id, direction: "in", text: `${text.slice(0, 1900)} [mid:${messageId}]`, by_kind: "human", channel: "email" });

  const { data: polls } = await db.from("polls").select("*").eq("party_id", party.id).eq("status", "open");
  const openPolls = (polls ?? []) as Poll[];
  let parsed = fastParse(text, openPolls);
  if (!parsed) parsed = await llmParse({ text, guestName: guest.name, partySizeMax: guest.party_size_max, polls: openPolls, partyId: party.id, purpose: "email_reply" });

  if (parsed.confidence < 0.6 || (!parsed.rsvp && !parsed.poll_answers?.length && !parsed.question)) {
    await db.from("review_queue").insert({ party_id: party.id, guest_id: guest.id, raw_text: text.slice(0, 4000), parse: parsed, reason: parsed.confidence < 0.6 ? "low confidence" : "nothing extracted" });
    return { queued: true, source: parsed.source };
  }
  const written: string[] = [];
  if (parsed.rsvp) {
    const size = parsed.rsvp.party_size ?? (parsed.rsvp.status === "yes" ? 1 : 0);
    await db.from("rsvps").insert({ guest_id: guest.id, status: parsed.rsvp.status, party_size: Math.min(size, guest.party_size_max), dietary: parsed.rsvp.dietary ?? [], note: parsed.rsvp.note ?? null, by_kind: "human", by_name: guest.name, channel: "email", idempotency_key: messageId });
    written.push("rsvp");
  }
  for (const a of parsed.poll_answers ?? []) {
    await db.from("poll_answers").insert({ poll_id: a.poll_id, guest_id: guest.id, choice: a.choice, by_kind: "human", by_name: guest.name, channel: "email", idempotency_key: `${messageId}:${a.poll_id}` });
    written.push("poll");
  }
  if (parsed.question) {
    await db.from("review_queue").insert({ party_id: party.id, guest_id: guest.id, raw_text: parsed.question, parse: parsed, reason: "question for host" });
    written.push("question");
  }
  return { written, source: parsed.source, confidence: parsed.confidence };
}

// Pull unread received mail for a party inbox and process it. Used by the host
// board as a belt-and-braces path when the webhook is slow.
export async function syncInbox(partyId: string) {
  const { data: party } = await db.from("parties").select("id,inbox_address").eq("id", partyId).single();
  if (!party?.inbox_address) return { processed: 0 };
  const list = await mail.inboxes.messages.list(party.inbox_address, { labels: ["received", "unread"], limit: 20 } as never).catch(() => null);
  const msgs = (list as { messages?: { messageId: string; from: string; subject?: string; text?: string; extractedText?: string }[] } | null)?.messages ?? [];
  const results = [];
  for (const m of msgs) {
    const r = await processInbound({ inboxId: party.inbox_address, messageId: m.messageId, from: m.from, subject: m.subject, text: m.extractedText ?? m.text });
    results.push(r);
    await mail.inboxes.messages.update(party.inbox_address, m.messageId, { removeLabels: ["unread"] } as never).catch(() => {});
  }
  return { processed: results.filter((r) => "written" in r).length, results };
}
