import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, neonFallback, table } from "./neon";
import { siteUrl } from "./token";

// Meet: the invite contract pointed at a person. The card owner carries a QR
// (/m/<slug>?c=<room>). Someone scans it and drops an address their agent
// reads. The owner's agent writes the first follow-up, human-readable with a
// machine block underneath, and both sides' agents take it from there.
// Only the owner installs anything. Everyone else just scans.

export const MEET_SPEC = "0.1";

export type MeetCard = {
  id: string; host_id: string; slug: string; display_name: string;
  headline: string | null; blurb: string | null;
  links: Record<string, string>; inbox_address: string | null; reply_to: string | null; agent_url: string | null;
  created_at: string;
};
export type MeetContext = { id: string; card_id: string; code: string; label: string; starts_at: string | null; ends_at: string | null; created_at: string };
export type MeetStatus = "dropped" | "sent" | "replied" | "scheduled" | "closed";
export type Meet = {
  id: string; card_id: string; context_id: string | null; context_label: string | null;
  name: string | null; agent_address: string; email: string | null; note: string | null;
  scopes: string[]; wants: string | null; status: MeetStatus; intro_message_id: string | null;
  created_at: string; sent_at: string | null; replied_at: string | null;
};

export const SCOPES = ["follow_up", "schedule", "share_deck", "intro"] as const;
export const SCOPE_LABELS: Record<(typeof SCOPES)[number], string> = {
  follow_up: "Send me a follow-up",
  schedule: "Propose times to talk",
  share_deck: "Share what you're building",
  intro: "Introduce me to people who fit",
};

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const fixCard = (r: Record<string, unknown>): MeetCard => ({ ...(r as MeetCard), links: (r.links as Record<string, string>) ?? {}, created_at: iso(r.created_at)! });
const fixCtx = (r: Record<string, unknown>): MeetContext => ({ ...(r as MeetContext), created_at: iso(r.created_at)!, starts_at: iso(r.starts_at), ends_at: iso(r.ends_at) });
const fixMeet = (r: Record<string, unknown>): Meet => ({ ...(r as Meet), scopes: (r.scopes as string[]) ?? [], created_at: iso(r.created_at)!, sent_at: iso(r.sent_at), replied_at: iso(r.replied_at) });

// ---------- bodies ----------

const addr = z.string().trim().min(3).max(200).refine((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || /^https:\/\/\S+$/.test(s), "an email address or an https:// endpoint your agent reads");

export const DropBody = z.object({
  agent_address: addr,
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(200).optional(),
  note: z.string().trim().max(600).optional(),
  wants: z.string().trim().max(300).optional(),
  scopes: z.array(z.enum(SCOPES)).max(4).default(["follow_up"]),
  context: z.string().trim().max(40).optional(),            // ?c= code
  by: z.object({ kind: z.enum(["agent", "human"]), name: z.string().trim().max(80).optional() }).optional(),
}).strict();

export const CardBody = z.object({
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  display_name: z.string().trim().min(1).max(80),
  headline: z.string().trim().max(160).optional(),
  blurb: z.string().trim().max(800).optional(),
  links: z.record(z.string().url().max(300)).default({}),
  inbox_address: z.string().email().optional(),
  reply_to: z.string().email().optional(),
  agent_url: z.string().url().optional(),
}).strict();

export const ContextBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,30}$/),
  label: z.string().trim().min(1).max(120),
  starts_at: z.string().datetime({ offset: true }).optional(),
  ends_at: z.string().datetime({ offset: true }).optional(),
}).strict();

// ---------- storage ----------

export async function loadCard(slug: string): Promise<MeetCard | null> {
  if (neonFallback()) return table<MeetCard>("meet_cards").find((c) => c.slug === slug) ?? null;
  const rows = await sql()`select * from meet_cards where slug = ${slug} limit 1`;
  return rows[0] ? fixCard(rows[0] as Record<string, unknown>) : null;
}

export async function listCards(hostId: string): Promise<MeetCard[]> {
  if (neonFallback()) return table<MeetCard>("meet_cards").filter((c) => c.host_id === hostId);
  const rows = await sql()`select * from meet_cards where host_id = ${hostId} order by created_at`;
  return (rows as Record<string, unknown>[]).map(fixCard);
}

export async function upsertCard(hostId: string, body: z.infer<typeof CardBody>): Promise<MeetCard> {
  const existing = await loadCard(body.slug);
  if (existing && existing.host_id !== hostId) throw new Error("slug taken");
  const c: MeetCard = {
    id: existing?.id ?? randomUUID(), host_id: hostId, slug: body.slug, display_name: body.display_name,
    headline: body.headline ?? null, blurb: body.blurb ?? null, links: body.links,
    inbox_address: body.inbox_address ?? existing?.inbox_address ?? null, reply_to: body.reply_to ?? existing?.reply_to ?? null, agent_url: body.agent_url ?? null,
    created_at: existing?.created_at ?? new Date().toISOString(),
  };
  if (neonFallback()) { const t = table<MeetCard>("meet_cards"); const i = t.findIndex((x) => x.id === c.id); if (i >= 0) t[i] = c; else t.push(c); return c; }
  await sql()`insert into meet_cards (id, host_id, slug, display_name, headline, blurb, links, inbox_address, reply_to, agent_url, created_at)
    values (${c.id}, ${c.host_id}, ${c.slug}, ${c.display_name}, ${c.headline}, ${c.blurb}, ${JSON.stringify(c.links)}, ${c.inbox_address}, ${c.reply_to}, ${c.agent_url}, ${c.created_at})
    on conflict (slug) do update set display_name = excluded.display_name, headline = excluded.headline, blurb = excluded.blurb, links = excluded.links,
      inbox_address = coalesce(excluded.inbox_address, meet_cards.inbox_address), reply_to = coalesce(excluded.reply_to, meet_cards.reply_to), agent_url = excluded.agent_url`;
  return c;
}

export async function listContexts(cardId: string): Promise<MeetContext[]> {
  if (neonFallback()) return table<MeetContext>("meet_contexts").filter((x) => x.card_id === cardId);
  const rows = await sql()`select * from meet_contexts where card_id = ${cardId} order by starts_at nulls last, created_at`;
  return (rows as Record<string, unknown>[]).map(fixCtx);
}

export async function upsertContext(cardId: string, body: z.infer<typeof ContextBody>): Promise<MeetContext> {
  const all = await listContexts(cardId);
  const existing = all.find((x) => x.code === body.code);
  const c: MeetContext = { id: existing?.id ?? randomUUID(), card_id: cardId, code: body.code, label: body.label, starts_at: body.starts_at ?? null, ends_at: body.ends_at ?? null, created_at: existing?.created_at ?? new Date().toISOString() };
  if (neonFallback()) { const t = table<MeetContext>("meet_contexts"); const i = t.findIndex((x) => x.id === c.id); if (i >= 0) t[i] = c; else t.push(c); return c; }
  await sql()`insert into meet_contexts (id, card_id, code, label, starts_at, ends_at, created_at) values (${c.id}, ${c.card_id}, ${c.code}, ${c.label}, ${c.starts_at}, ${c.ends_at}, ${c.created_at})
    on conflict (card_id, code) do update set label = excluded.label, starts_at = excluded.starts_at, ends_at = excluded.ends_at`;
  return c;
}

// The room for a scan: explicit ?c= code first, else whatever context is live now.
export async function resolveContext(card: MeetCard, code?: string | null): Promise<MeetContext | null> {
  const all = await listContexts(card.id);
  if (code) return all.find((x) => x.code === code) ?? null;
  const now = Date.now();
  return all.find((x) => x.starts_at && x.ends_at && Date.parse(x.starts_at) <= now && now <= Date.parse(x.ends_at)) ?? null;
}

export async function listMeets(cardId: string): Promise<Meet[]> {
  if (neonFallback()) return table<Meet>("meets").filter((m) => m.card_id === cardId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows = await sql()`select * from meets where card_id = ${cardId} order by created_at desc`;
  return (rows as Record<string, unknown>[]).map(fixMeet);
}

export async function createMeet(card: MeetCard, ctx: MeetContext | null, body: z.infer<typeof DropBody>): Promise<Meet> {
  const m: Meet = {
    id: randomUUID(), card_id: card.id, context_id: ctx?.id ?? null, context_label: ctx?.label ?? null,
    name: body.name || null, agent_address: body.agent_address.toLowerCase(), email: body.email ?? (body.agent_address.includes("@") ? body.agent_address.toLowerCase() : null),
    note: body.note || null, scopes: body.scopes, wants: body.wants || null, status: "dropped", intro_message_id: null,
    created_at: new Date().toISOString(), sent_at: null, replied_at: null,
  };
  if (neonFallback()) { table<Meet>("meets").push(m); return m; }
  await sql()`insert into meets (id, card_id, context_id, context_label, name, agent_address, email, note, scopes, wants, status, created_at)
    values (${m.id}, ${m.card_id}, ${m.context_id}, ${m.context_label}, ${m.name}, ${m.agent_address}, ${m.email}, ${m.note}, ${m.scopes}, ${m.wants}, 'dropped', ${m.created_at})`;
  return m;
}

export async function markIntroSent(id: string, messageId: string | null) {
  const now = new Date().toISOString();
  if (neonFallback()) { const m = table<Meet>("meets").find((x) => x.id === id); if (m) Object.assign(m, { status: "sent", sent_at: now, intro_message_id: messageId }); return; }
  await sql()`update meets set status = 'sent', sent_at = ${now}, intro_message_id = ${messageId} where id = ${id}`;
}

// ---------- documents ----------

export const cardUrl = (card: MeetCard, code?: string | null) => `${siteUrl()}/m/${card.slug}${code ? `?c=${encodeURIComponent(code)}` : ""}`;

// The card as an agent reads it: who this is, what they want, how to answer.
export function cardJson(card: MeetCard, ctx: MeetContext | null) {
  const base = `${siteUrl()}/m/${card.slug}`;
  return {
    "@type": "IndbyAgent/Meet",
    spec: MEET_SPEC,
    person: { name: card.display_name, headline: card.headline, about: card.blurb, links: card.links, agent: card.agent_url ?? card.inbox_address },
    met_at: ctx ? { code: ctx.code, label: ctx.label, starts_at: ctx.starts_at, ends_at: ctx.ends_at } : null,
    actions: {
      drop: {
        method: "POST", url: `${base}/drop`,
        body: { agent_address: "email or https:// endpoint your agent reads (required)", name: "string?", email: "string?", note: "what we talked about (string?)", wants: "what you want from this (string?)", scopes: SCOPES, context: "the ?c= code from the QR (string?)", by: { kind: "agent|human", name: "string?" } },
        then: "the person's agent emails your agent_address a follow-up with a machine-readable block; reply in the thread or POST to the reply url it carries",
      },
    },
    formats: { json: `${base}.json`, text: `${base}.txt` },
  };
}

export function cardText(card: MeetCard, ctx: MeetContext | null): string {
  const base = `${siteUrl()}/m/${card.slug}`;
  return [
    `IndbyAgent Meet v${MEET_SPEC}`,
    `Person: ${card.display_name}${card.headline ? ` — ${card.headline}` : ""}`,
    card.blurb ? `About: ${card.blurb}` : null,
    ...Object.entries(card.links).map(([k, v]) => `${k}: ${v}`),
    ctx ? `Met at: ${ctx.label}` : null,
    ``,
    `To connect your agent: POST ${base}/drop with JSON {agent_address, name?, note?, wants?, scopes?[follow_up|schedule|share_deck|intro], context?}.`,
    `agent_address is an email address or an https:// endpoint. ${card.display_name}'s agent will write to it with a follow-up and a machine-readable block.`,
    `JSON: ${base}.json`,
  ].filter((l) => l !== null).join("\n");
}

// What the owner's agent sends after a drop. Human-readable first, machine block last.
export function introMail(card: MeetCard, m: Meet) {
  const where = m.context_label ? ` at ${m.context_label}` : "";
  const who = m.name ? m.name.split(" ")[0] : "there";
  const subject = `Good to meet you${m.context_label ? ` at ${m.context_label.split(",")[0]}` : ""} [IndbyAgent M-${m.id.slice(0, 8)}]`;
  const wants = m.scopes.map((s) => SCOPE_LABELS[s as keyof typeof SCOPE_LABELS] ?? s);
  const block = {
    "@type": "IndbyAgent/Meet.Intro", spec: MEET_SPEC, meet_id: m.id,
    from: { name: card.display_name, headline: card.headline, links: card.links, agent: card.inbox_address, reply_to: card.reply_to },
    to: { name: m.name, agent_address: m.agent_address },
    met_at: m.context_label, their_note: m.note, they_want: m.wants, scopes: m.scopes,
    proposed: m.scopes.includes("schedule") ? { kind: "call", duration_min: 30, window: "this week", respond: "reply with 2-3 times or a scheduling link" } : { kind: "follow_up" },
    reply: { how: "reply to this email; an agent may answer with JSON in the body", include: ["times or link", "what you want from this", "anything to send"] },
  };
  const text = [
    `Hi ${who},`,
    ``,
    `This is ${card.display_name}'s agent. Good to meet you${where}.${m.note ? ` You mentioned: "${m.note}".` : ""}`,
    card.headline ? `` : null,
    card.headline ? `${card.display_name.split(" ")[0]} is working on: ${card.headline}${card.blurb ? ` ${card.blurb}` : ""}` : null,
    ``,
    wants.length ? `You asked for: ${wants.join("; ").toLowerCase()}.` : null,
    m.scopes.includes("schedule") ? `Would 30 minutes this week work? Reply with two or three times, or a scheduling link, and I'll put it on ${card.display_name.split(" ")[0]}'s calendar.` : `Reply here any time; I read this inbox and ${card.display_name.split(" ")[0]} sees every message.`,
    m.wants ? `` : null,
    m.wants ? `You said you want: ${m.wants}. I'll make sure that's what we talk about.` : null,
    ``,
    ...Object.entries(card.links).map(([k, v]) => `${k}: ${v}`),
    ``,
    `If you have an agent, the block below is for it.`,
    ``,
    "```json",
    JSON.stringify(block, null, 2),
    "```",
    ``,
    `— ${card.display_name}'s agent, via IndbyAgent (indbyagent.com)`,
  ].filter((l) => l !== null).join("\n");
  return { subject, text, block };
}
