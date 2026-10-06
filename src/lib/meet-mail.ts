import { mail } from "./mail";
import { fallback } from "./fallback";
import { markIntroSent, type Meet, type MeetCard } from "./meet";
import { composeIntro, composeReply, addMessage, listMessages, seenMessage, updateMeet, findMeetForReply, type AgentAction } from "./meet-agent";

// Outbound side of the owner's agent. Everything it sends is logged on the
// meet; everything that needs the owner goes to reply_to as a short handoff.

async function send(card: MeetCard, to: string, subject: string, text: string, labels: string[]): Promise<{ via: "email" | "console"; message_id: string | null }> {
  const from = card.inbox_address ?? process.env.AGENTMAIL_SHARED_INBOX;
  if (fallback.mail || !from) {
    console.log(`\n----- meet mail (not sent: ${from ? "AgentMail not configured" : "card has no inbox"}) -----\nFrom: ${from ?? "?"}\nTo: ${to}\nSubject: ${subject}\n\n${text}\n-----\n`);
    return { via: "console", message_id: null };
  }
  const sent = await mail.inboxes.messages.send(from, { to: [to], subject, text, labels });
  return { via: "email", message_id: (sent as { messageId?: string } | undefined)?.messageId ?? null };
}

// First message after a scan. https:// addresses get the JSON block POSTed.
export async function sendMeetIntro(card: MeetCard, m: Meet): Promise<{ via: "email" | "https" | "console"; to: string; message_id?: string | null }> {
  const intro = await composeIntro(card, m);
  const to = m.agent_address;
  if (to.startsWith("https://")) {
    const res = await fetch(to, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ subject: intro.subject, text: intro.text, meet_id: m.id }) });
    if (!res.ok) throw new Error(`agent endpoint answered ${res.status}`);
    await markIntroSent(m.id, null);
    await addMessage({ meet_id: m.id, direction: "out", by_kind: "agent", text: intro.text, message_id: null, action: intro.action, meta: { via: "https" } });
    return { via: "https", to };
  }
  const r = await send(card, to, intro.subject, intro.text, [`meet:${m.id}`, `card:${card.id}`]);
  await markIntroSent(m.id, r.message_id);
  await addMessage({ meet_id: m.id, direction: "out", by_kind: "agent", text: intro.text, message_id: r.message_id, action: intro.action, meta: { via: r.via } });
  await updateMeet(m.id, { summary: intro.summary, proposed_times: intro.proposed_times.length ? intro.proposed_times : null });
  return { via: r.via, to, message_id: r.message_id };
}

// A reply to the owner's inbox that belongs to a meet. Idempotent per message id.
export async function handleMeetInbound(card: MeetCard, opts: { messageId: string; from: string; subject: string; text: string }) {
  if (await seenMessage(opts.messageId)) return { ignored: "duplicate" };
  const fromEmail = (opts.from.match(/<([^>]+)>/)?.[1] ?? opts.from).trim().toLowerCase();
  const m = await findMeetForReply(card, fromEmail, opts.subject);
  if (!m) return { ignored: "no meet for sender" };
  const text = opts.text.replace(/\r/g, "").trim();
  await addMessage({ meet_id: m.id, direction: "in", by_kind: /"@type"\s*:\s*"IndbyAgent/.test(text) ? "agent" : "human", text: text.slice(0, 8000), message_id: opts.messageId, action: null, meta: { from: fromEmail, subject: opts.subject } });
  await updateMeet(m.id, { replied_at: new Date().toISOString(), status: m.status === "stopped" ? "stopped" : "replied" });
  if (m.status === "stopped") return { ignored: "stopped" };

  const history = await listMessages([m.id]);
  const j = await composeReply(card, m, history.slice(0, -1), text);
  const first = card.display_name.split(" ")[0];
  if (!j) {
    await escalate(card, m, `Reply from ${m.name ?? fromEmail} needs you (agent unavailable).`, text);
    await updateMeet(m.id, { status: "needs_human" });
    return { escalated: "no model" };
  }
  const subject = opts.subject.startsWith("Re:") ? opts.subject : `Re: ${opts.subject}`;
  const r = await send(card, m.agent_address, subject, j.reply_text, [`meet:${m.id}`, `card:${card.id}`]);
  await addMessage({ meet_id: m.id, direction: "out", by_kind: "agent", text: j.reply_text, message_id: r.message_id, action: j.action, meta: { confidence: j.confidence, picked_time: j.picked_time } });
  const action: AgentAction = j.action;
  const patch: Parameters<typeof updateMeet>[1] = { summary: j.summary || m.summary };
  if (j.proposed_times?.length) patch.proposed_times = j.proposed_times;
  if (action === "stop") patch.status = "stopped";
  else if (action === "escalate") { patch.status = "needs_human"; await escalate(card, m, j.escalation_reason ?? "needs your call", text, j.reply_text); }
  else if (action === "confirm_time") { patch.status = "needs_human"; await escalate(card, m, `${m.name ?? fromEmail} picked ${j.picked_time ?? "a time"}. Confirm and send the invite.`, text, j.reply_text); }
  else patch.status = "replied";
  await updateMeet(m.id, patch);
  return { replied: action, to: m.agent_address, via: r.via, meet_id: m.id };
}

// Short handoff to the owner's human inbox. Never silent.
async function escalate(card: MeetCard, m: Meet, reason: string, theirText: string, agentReply?: string) {
  if (!card.reply_to) return;
  const subject = `[Meet] ${m.name ?? m.agent_address}: ${reason.slice(0, 80)}`;
  const text = [
    `${reason}`,
    ``,
    `Who: ${m.name ?? "unknown"} <${m.agent_address}>${m.context_label ? ` · met at ${m.context_label}` : ""}`,
    m.summary ? `Thread so far: ${m.summary}` : null,
    ``,
    `They wrote:`,
    theirText.slice(0, 1500),
    agentReply ? `\nYour agent replied:\n${agentReply.slice(0, 1200)}` : `\nYour agent did not reply; this is on you.`,
    ``,
    `Reply to them directly from ${card.inbox_address ?? "the inbox"} or tell your agent what to say.`,
  ].filter((l) => l !== null).join("\n");
  await send(card, card.reply_to, subject, text, [`meet:${m.id}`, "handoff"]);
}
