import { AgentMailClient } from "agentmail";
import { db, type Party, type Poll } from "./db";
import type { VenueSuggestion } from "./vendors";
import type { VendorRequest } from "./vendor-requests";
import { fmtDate, fmtWhen } from "./invite";
import { siteUrl } from "./token";
import { fallback } from "./fallback";
import { accountForHost, ownClientForInbox, isLimitError } from "./own-inbox";

export const mail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY ?? "" });
const CONSOLE_INBOX = "server console";

// Subject tag that pins a reply to its party even when parties share an inbox.
export const partyTag = (id: string) => `[IndbyAgent P-${id.replace(/-/g, "").slice(0, 8)}]`;
export const partyTagOf = (subject: string) => subject.match(/\[IndbyAgent P-([0-9a-f]{8})\]/i)?.[1]?.toLowerCase() ?? null;

// One inbox per party. Address is remembered on the party row.
// If the AgentMail plan's inbox limit is hit, parties share AGENTMAIL_SHARED_INBOX
// and inbound replies are routed by sender address + subject (see inbound.ts).
export async function ensureInbox(party: Party): Promise<string> {
  if (fallback.mail) return CONSOLE_INBOX;
  if (party.inbox_address) return party.inbox_address;
  let address: string | undefined;
  // The host's own verified AgentMail inbox, if they set one up.
  const { data: host } = await db.from("hosts").select("id,email,auth_user_id").eq("id", party.host_id).maybeSingle();
  const own = host ? await accountForHost(host as { id: string; email: string | null; auth_user_id: string | null }) : null;
  if (own?.status === "verified") {
    await db.from("parties").update({ inbox_address: own.inbox_id }).eq("id", party.id);
    return own.inbox_id;
  }
  try {
    const inbox = await mail.inboxes.create({
      username: party.slug.replace(/[^a-z0-9-]/g, "").slice(0, 30),
      displayName: party.title,
      clientId: `party-${party.id}`,
    });
    address = inbox.inboxId;
  } catch (e) {
    address = (await claimPooledInbox(party)) ?? process.env.AGENTMAIL_SHARED_INBOX;
    if (!address) throw e;
  }
  await db.from("parties").update({ inbox_address: address }).eq("id", party.id);
  return address;
}

// Plan inbox limit hit: reuse an inbox from AGENTMAIL_POOL_INBOXES (comma list)
// that no live party holds. A party stops holding its inbox 14 days after it
// starts; an undated party holds it until then. The inbox is renamed to the
// party title so guests see the party as the sender.
export async function claimPooledInbox(party: Party): Promise<string | null> {
  const pool = (process.env.AGENTMAIL_POOL_INBOXES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!pool.length) return null;
  const cutoff = Date.now() - 14 * 864e5;
  const { data: holders } = await db.from("parties").select("inbox_address,starts_at").in("inbox_address", pool);
  const busy = new Set((holders ?? []).filter((h) => !h.starts_at || Date.parse(h.starts_at) > cutoff).map((h) => h.inbox_address));
  const free = pool.find((a) => !busy.has(a));
  if (!free) return null;
  await mail.inboxes.update(free, { displayName: party.title.slice(0, 60) }).catch(() => {});
  return free;
}

// Send from a party's inbox. A subscriber's own inbox sends with their key; if
// AgentMail refuses it for a plan or new-account ramp limit, the message goes
// out from an IndbyAgent inbox instead (pool, then shared). Replies still route
// to the party by the subject tag.
type SendBody = { to: string[]; subject: string; text: string; labels?: string[] };
export async function sendFrom(party: Party, from: string, body: SendBody): Promise<string> {
  const own = await ownClientForInbox(from).catch(() => null);
  if (!own) { await mail.inboxes.messages.send(from, body); return from; }
  try {
    await own.inboxes.messages.send(from, body);
    return from;
  } catch (e) {
    if (!isLimitError(e)) throw e;
    const alt = (await claimPooledInbox(party)) ?? process.env.AGENTMAIL_SHARED_INBOX;
    if (!alt) throw e;
    const subject = body.subject.includes(partyTag(party.id)) ? body.subject : `${body.subject} ${partyTag(party.id)}`;
    await mail.inboxes.messages.send(alt, { ...body, subject, labels: [...(body.labels ?? []), "overflow"] });
    return alt;
  }
}

// Invite copy is templated, not generated: zero model tokens per guest.
// lockedPolls: polls shown only after the guest RSVPs yes, so only counted here.
export function inviteEmail(party: Party, guestName: string, url: string, datePolls: Poll[] = [], lockedPolls = 0) {
  const when = fmtWhen(party);
  const subject = `You're invited: ${party.title} ${partyTag(party.id)}`;
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

// Tells the host a venue suggestion is waiting. Sends only from an inbox the
// party already has (or the shared one), so it never creates or records an inbox.
export async function notifyHostOfVenue(party: Party, s: VenueSuggestion): Promise<{ notified: "email" | "console" | "board_only"; to?: string }> {
  const { data: host } = await db.from("hosts").select("email").eq("id", party.host_id).maybeSingle();
  const to = host?.email as string | undefined;
  if (!to) return { notified: "board_only" };
  const fmtList = (xs: string[]) => xs.join(", ") || "none";
  const subject = `Venue suggestion for ${party.title}: ${s.venue.name}`;
  const text = [
    `Your planning agent found a venue for ${party.title}${s.mock ? " (demo result from local test mode, not a live search)" : ""}.`,
    ``,
    `${s.venue.name}`,
    s.venue.address,
    s.venue.url ?? null,
    ``,
    `When: ${fmtDate(s.target_time, party.timezone)}`,
    `Open then? ${s.availability.status === "open" ? "Yes, per its published hours" : s.availability.status === "closed" ? "No, per its published hours" : "Unknown"}. ${s.availability.evidence}`,
    `Booking isn't confirmed; ${s.availability.booking_url ? `book or ask at ${s.availability.booking_url}` : "contact the venue to book"}.`,
    ``,
    `Why: ${s.venue.why}`,
    `Fit: ${s.venue.capacity_fit}${s.venue.est_cost ? ` · Est. cost: ${s.venue.est_cost}` : ""}`,
    ``,
    `Invitees who can make that time: ${fmtList(s.invitees.available)}`,
    `Can't make it: ${fmtList(s.invitees.unavailable)}`,
    `Haven't said: ${fmtList(s.invitees.unknown)}`,
    ``,
    ...(s.vendors.length ? [`Vendors to consider:`, ...s.vendors.map((v) => `  - ${v.category}: ${v.name}${v.url ? ` (${v.url})` : ""}: ${v.why}`), ``] : []),
    `Confirm or reject it on your board: ${siteUrl()}/host`,
  ].filter((l) => l !== null).join("\n");
  if (fallback.mail) {
    console.log(`\n----- venue notification (not sent: AgentMail not configured) -----\nTo: ${to}\nSubject: ${subject}\n\n${text}\n-----\n`);
    return { notified: "console", to };
  }
  const from = party.inbox_address ?? process.env.AGENTMAIL_SHARED_INBOX;
  if (!from) return { notified: "board_only" };
  await sendFrom(party, from, { to: [to], subject, text, labels: [`party:${party.id}`, "venue"] });
  return { notified: "email", to };
}

export async function sendInvites(party: Party, guests: { id: string; name: string; email: string; token: string }[]) {
  const from = await ensureInbox(party);
  const { data: openPolls } = await db.from("polls").select("*").eq("party_id", party.id).eq("status", "open");
  const datePolls = ((openPolls ?? []) as Poll[]).filter((p) => p.kind === "dates");
  const count = ((openPolls ?? []) as Poll[]).filter((p) => p.kind !== "dates").length;
  let sent = 0;
  for (const g of guests) {
    const url = `${siteUrl()}/i/${g.token}`;
    const { subject, text } = inviteEmail(party, g.name, url, datePolls, count);
    if (fallback.mail) console.log(`\n----- invite email (not sent: AgentMail not configured) -----\nTo: ${g.email}\nSubject: ${subject}\n\n${text}\n-----\n`);
    else await sendFrom(party, from, { to: [g.email], subject, text, labels: [`guest:${g.id}`, `party:${party.id}`] });
    await db.from("messages").insert({ party_id: party.id, guest_id: g.id, direction: "out", text: `Invite emailed to ${g.email}`, by_kind: "host", channel: "email" });
    sent++;
  }
  return { from, sent };
}

// Request for quote to a vendor. Templated: zero model tokens.
export async function sendVendorRequest(party: Party, r: VendorRequest, url: string) {
  const from = await ensureInbox(party);
  const when = party.starts_at ? fmtDate(party.starts_at, party.timezone) : "date not final yet";
  const subject = `Quote request: ${r.vendor.category} for ${party.title} [IndbyAgent V-${r.id.slice(0, 8)}]`;
  const text = [
    `Hello ${r.vendor.name},`,
    ``,
    `I'm hosting ${party.title} (${when}${party.location ? `, ${party.location}` : ""}) and would like a quote.`,
    ``,
    `What we need: ${r.need}`,
    r.budget_line ? `Budget line: ${r.budget_line}` : null,
    r.needed_by ? `Needed by: ${r.needed_by}` : null,
    ``,
    `Reply with a price and whether you're available here (this link is yours alone): ${url}`,
    `Or just reply to this email with your price, availability and any notes.`,
    `If you have an assistant or agent, it can read ${url}.json and answer for you.`,
    ``,
    `A quote isn't a booking; I'll confirm in writing before anything is reserved or paid.`,
    ``,
    `— sent by IndbyAgent for ${party.title}`,
  ].filter((l) => l !== null).join("\n");
  if (fallback.mail) { console.log(`\n----- vendor request (not sent: AgentMail not configured) -----\nTo: ${r.vendor.email}\nSubject: ${subject}\n\n${text}\n-----\n`); return { from: CONSOLE_INBOX }; }
  await sendFrom(party, from, { to: [r.vendor.email!], subject, text, labels: [`vendor:${r.id}`, `party:${party.id}`] });
  return { from };
}
