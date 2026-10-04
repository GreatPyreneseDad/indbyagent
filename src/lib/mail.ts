import { AgentMailClient } from "agentmail";
import { db, type Party } from "./db";
import { fmtWhen } from "./invite";
import { siteUrl } from "./token";

export const mail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });

// One inbox per party. Address is remembered on the party row.
export async function ensureInbox(party: Party): Promise<string> {
  if (party.inbox_address) return party.inbox_address;
  const inbox = await mail.inboxes.create({
    username: party.slug.replace(/[^a-z0-9-]/g, "").slice(0, 30),
    displayName: party.title,
    clientId: `party:${party.id}`,
  });
  const address = inbox.inboxId;
  await db.from("parties").update({ inbox_address: address }).eq("id", party.id);
  return address;
}

// Invite copy is templated, not generated: zero model tokens per guest.
export function inviteEmail(party: Party, guestName: string, url: string) {
  const when = fmtWhen(party);
  const subject = `You're invited: ${party.title}`;
  const text = [
    `Hi ${guestName},`,
    ``,
    `You're invited to ${party.title}.`,
    `When: ${when}`,
    party.location ? `Where: ${party.location}` : null,
    party.details ? `` : null,
    party.details ?? null,
    ``,
    `RSVP here (this link is yours alone): ${url}`,
    ``,
    `Or just reply to this email with yes / no / maybe, how many are coming, and any dietary needs.`,
    `If you have a personal agent, give it the link: it can read ${url}.json and answer for you.`,
    ``,
    `— sent by IndbyAgent for ${party.title}`,
  ].filter((l) => l !== null).join("\n");
  return { subject, text };
}

export async function sendInvites(party: Party, guests: { id: string; name: string; email: string; token: string }[]) {
  const from = await ensureInbox(party);
  let sent = 0;
  for (const g of guests) {
    const url = `${siteUrl()}/i/${g.token}`;
    const { subject, text } = inviteEmail(party, g.name, url);
    await mail.inboxes.messages.send(from, { to: [g.email], subject, text, labels: [`guest:${g.id}`] });
    await db.from("messages").insert({ party_id: party.id, guest_id: g.id, direction: "out", text: `Invite emailed to ${g.email}`, by_kind: "host", channel: "email" });
    sent++;
  }
  return { from, sent };
}
