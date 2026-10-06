import { mail } from "./mail";
import { fallback } from "./fallback";
import { introMail, markIntroSent, type Meet, type MeetCard } from "./meet";

// The first message after a scan, sent by the card owner's agent from the
// owner's inbox. Templated: zero model tokens. Human-readable with a JSON
// block the other agent can act on. If the dropped address is an https://
// endpoint instead of an email, we POST the block there.
export async function sendMeetIntro(card: MeetCard, m: Meet): Promise<{ via: "email" | "https" | "console"; to: string; message_id?: string | null }> {
  const { subject, text, block } = introMail(card, m);
  const to = m.agent_address;
  if (to.startsWith("https://")) {
    const res = await fetch(to, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ subject, text, ...block }) });
    if (!res.ok) throw new Error(`agent endpoint answered ${res.status}`);
    await markIntroSent(m.id, null);
    return { via: "https", to };
  }
  const from = card.inbox_address ?? process.env.AGENTMAIL_SHARED_INBOX;
  if (fallback.mail || !from) {
    console.log(`\n----- meet intro (not sent: ${from ? "AgentMail not configured" : "card has no inbox"}) -----\nFrom: ${from ?? "?"}\nTo: ${to}\nSubject: ${subject}\n\n${text}\n-----\n`);
    await markIntroSent(m.id, null);
    return { via: "console", to };
  }
  const sent = await mail.inboxes.messages.send(from, { to: [to], subject, text, labels: [`meet:${m.id}`, `card:${card.id}`] });
  const id = (sent as { messageId?: string } | undefined)?.messageId ?? null;
  await markIntroSent(m.id, id);
  return { via: "email", to, message_id: id };
}
