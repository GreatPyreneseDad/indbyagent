import { AgentMailClient } from "agentmail";
import { db, type Party, type Poll } from "./db";
import { fmtDate, fmtWhen } from "./invite";
import { siteUrl } from "./token";

export const mail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });

// One inbox per party. Address is remembered on the party row.
// If the AgentMail plan's inbox limit is hit, parties share AGENTMAIL_SHARED_INBOX
// and inbound replies are routed by sender address + subject (see inbound.ts).
export async function ensureInbox(party: Party): Promise<string> {
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
export function inviteEmail(party: Party, guestName: string, url: string, polls: Poll[] = []) {
  const when = fmtWhen(party);
  const subject = `You're invited: ${party.title}`;
  const datePolls = polls.filter((p) => p.kind === "date_rank");
  const locked = polls.length - datePolls.length;
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
  const { data: polls } = await db.from("polls").select("*").eq("party_id", party.id).eq("status", "open").order("created_at");
  let sent = 0;
  for (const g of guests) {
    const url = `${siteUrl()}/i/${g.token}`;
    const { subject, text } = inviteEmail(party, g.name, url, (polls ?? []) as Poll[]);
    await mail.inboxes.messages.send(from, { to: [g.email], subject, text, labels: [`guest:${g.id}`, `party:${party.id}`] });
    await db.from("messages").insert({ party_id: party.id, guest_id: g.id, direction: "out", text: `Invite emailed to ${g.email}`, by_kind: "host", channel: "email" });
    sent++;
  }
  return { from, sent };
}
