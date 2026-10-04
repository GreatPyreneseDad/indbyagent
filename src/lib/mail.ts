import { AgentMailClient } from "agentmail";
import { db, type Party } from "./db";
import { store, type DatePoll } from "./store";
import { fmtDate, fmtWhen } from "./invite";
import { siteUrl } from "./token";
import { fallback } from "./fallback";

export const mail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY ?? "" });
const CONSOLE_INBOX = "server console";

// One inbox per party. Address is remembered on the party row.
// If the AgentMail plan's inbox limit is hit, parties share AGENTMAIL_SHARED_INBOX
// and inbound replies are routed by sender address + subject (see inbound.ts).
export async function ensureInbox(party: Party): Promise<string> {
  if (fallback.mail) return CONSOLE_INBOX;
  if (party.inbox_address) return party.inbox_address;
  let address: string | undefined;
  try {
    const inbox = await mail.inboxes.create({
      username: party.slug.replace(/[^a-z0-9-]/g, "").slice(0, 30),
      displayName: party.title,
      clientId: `party-${party.id}`,
    });
    address = inbox.inboxId;
  } catch (e) {
    const shared = process.env.AGENTMAIL_SHARED_INBOX;
    if (!shared) throw e;
    address = shared;
  }
  await db.from("parties").update({ inbox_address: address }).eq("id", party.id);
  return address;
}

// Invite copy is templated, not generated: zero model tokens per guest.
// lockedPolls: polls shown only after the guest RSVPs yes, so only counted here.
export function inviteEmail(party: Party, guestName: string, url: string, datePoll: DatePoll | null = null, lockedPolls = 0) {
  const when = fmtWhen(party);
  const subject = `You're invited: ${party.title}`;
  const datePolls = datePoll ? [datePoll] : [];
  const locked = lockedPolls;
  const text = [
    `Hi ${guestName},`,
    ``,
    `You're invited to ${party.title}.`,
    datePolls.length ? `When: ${when} (the date isn't final yet, see below)` : `When: ${when}`,
    party.location ? `Where: ${party.location}` : null,
    party.details ? `` : null,
    party.details ?? null,
    ``,
    `RSVP here (this link is yours alone): ${url}`,
    ``,
    ...datePolls.flatMap((p) => [
      `${p.question} Rank the dates that work for you at your link and press Save:`,
      ...p.options.map((o) => `  - ${fmtDate(o, party.timezone)}`),
      ``,
    ]),
    locked ? `The host also has ${locked} quick poll${locked > 1 ? "s" : ""} for guests who are coming. RSVP yes at your link to answer.` : null,
    locked ? `` : null,
    `Or just reply to this email with yes / no / maybe, how many are coming, and any dietary needs.`,
    `If you have a personal agent, give it the link: it can read ${url}.json and answer for you.`,
    ``,
    `— sent by IndbyAgent for ${party.title}`,
  ].filter((l) => l !== null).join("\n");
  return { subject, text };
}

export async function sendInvites(party: Party, guests: { id: string; name: string; email: string; token: string }[]) {
  const from = await ensureInbox(party);
  const [{ count }, datePoll] = await Promise.all([
    db.from("polls").select("id", { count: "exact", head: true }).eq("party_id", party.id).eq("status", "open"),
    store.datePoll(party.id),
  ]);
  let sent = 0;
  for (const g of guests) {
    const url = `${siteUrl()}/i/${g.token}`;
    const { subject, text } = inviteEmail(party, g.name, url, datePoll, count ?? 0);
    if (fallback.mail) console.log(`\n----- invite email (not sent: AgentMail not configured) -----\nTo: ${g.email}\nSubject: ${subject}\n\n${text}\n-----\n`);
    else await mail.inboxes.messages.send(from, { to: [g.email], subject, text, labels: [`guest:${g.id}`, `party:${party.id}`] });
    await db.from("messages").insert({ party_id: party.id, guest_id: g.id, direction: "out", text: `Invite emailed to ${g.email}`, by_kind: "host", channel: "email" });
    sent++;
  }
  return { from, sent };
}
