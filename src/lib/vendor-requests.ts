import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, neonFallback, table } from "./neon";
import { hashToken, looksLikeToken, newToken, siteUrl } from "./token";
import { fmtDate } from "./invite";
import type { Party } from "./db";

// A request for quote: the invite contract pointed at a vendor. One token per
// vendor × party × need. The vendor (or its agent) reads /v/<token> and answers
// with quote | message | decline. Nothing here reaches the guest invite, and
// nothing here moves money (see payments.ts, which needs the host's say-so).

export const SPEC_VERSION = "0.2";

export type Vendor = { name: string; category: string; url?: string | null; phone?: string | null; email?: string | null; address?: string | null };
export type RequestStatus = "draft" | "sent" | "quoted" | "declined" | "accepted" | "closed";
export type VendorRequest = {
  id: string; party_id: string; host_id: string; suggestion_id: string | null;
  vendor: Vendor; need: string; budget_line: string | null; needed_by: string | null;
  token_hash: string; token_revoked_at: string | null;
  status: RequestStatus; channel: string | null;
  created_at: string; sent_at: string | null; decided_at: string | null;
};
export type VendorReply = {
  id: string; request_id: string; kind: "quote" | "message" | "decline";
  price: number | null; currency: string; available: "yes" | "no" | "alternative" | null; alternative: string | null;
  lead_time_days: number | null; notes: string | null; valid_until: string | null;
  raw_text: string | null; evidence: string | null; confidence: number | null; source: string;
  by_kind: string; by_name: string | null; channel: string; idempotency_key: string | null; created_at: string;
};

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const fixReq = (r: Record<string, unknown>): VendorRequest => ({
  ...(r as VendorRequest),
  created_at: iso(r.created_at)!, sent_at: iso(r.sent_at), decided_at: iso(r.decided_at), token_revoked_at: iso(r.token_revoked_at),
  needed_by: r.needed_by ? String(r.needed_by).slice(0, 10) : null,
});
const fixReply = (r: Record<string, unknown>): VendorReply => ({
  ...(r as VendorReply),
  price: r.price == null ? null : Number(r.price), confidence: r.confidence == null ? null : Number(r.confidence),
  created_at: iso(r.created_at)!, alternative: iso(r.alternative), valid_until: r.valid_until ? String(r.valid_until).slice(0, 10) : null,
});

// ---------- bodies ----------

export const VendorBody = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(40),
  url: z.string().url().max(300).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),
});
export const RequestCreateBody = z.object({
  vendor: VendorBody,
  suggestion_id: z.string().uuid().optional(),
  need: z.string().trim().min(1).max(500),
  budget_line: z.string().trim().max(80).optional(),
  needed_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
export const RequestPatchBody = z.object({
  status: z.enum(["accepted", "closed"]).optional(),
  revoke_link: z.boolean().optional(),
}).strict();

const By = z.object({ kind: z.enum(["agent", "human"]), name: z.string().trim().max(80).optional() }).optional();
export const QuoteBody = z.object({
  price: z.number().nonnegative().max(1_000_000),
  currency: z.string().trim().length(3).default("usd"),
  available: z.enum(["yes", "no", "alternative"]),
  alternative: z.string().datetime({ offset: true }).nullable().optional(),
  lead_time_days: z.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(1000).optional(),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  by: By,
}).strict();
export const VendorMessageBody = z.object({ text: z.string().trim().min(1).max(2000), by: By }).strict();
export const DeclineBody = z.object({ reason: z.string().trim().max(500).optional(), by: By }).strict();

// ---------- storage ----------

export async function listRequests(partyId: string, hostId: string): Promise<VendorRequest[]> {
  if (neonFallback()) return table<VendorRequest>("vendor_requests").filter((r) => r.party_id === partyId && r.host_id === hostId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows = await sql()`select * from vendor_requests where party_id = ${partyId} and host_id = ${hostId} order by created_at desc`;
  return (rows as Record<string, unknown>[]).map(fixReq);
}

export async function getRequest(partyId: string, hostId: string, id: string): Promise<VendorRequest | null> {
  return (await listRequests(partyId, hostId)).find((r) => r.id === id) ?? null;
}

// Returns the plaintext token once; only its hash is stored.
export async function createRequest(partyId: string, hostId: string, body: z.infer<typeof RequestCreateBody>): Promise<{ request: VendorRequest; token: string }> {
  const token = newToken();
  const r: VendorRequest = {
    id: randomUUID(), party_id: partyId, host_id: hostId, suggestion_id: body.suggestion_id ?? null,
    vendor: body.vendor, need: body.need, budget_line: body.budget_line ?? null, needed_by: body.needed_by ?? null,
    token_hash: hashToken(token), token_revoked_at: null, status: "draft", channel: null,
    created_at: new Date().toISOString(), sent_at: null, decided_at: null,
  };
  if (neonFallback()) { table<VendorRequest>("vendor_requests").push(r); return { request: r, token }; }
  await sql()`insert into vendor_requests (id, party_id, host_id, suggestion_id, vendor, need, budget_line, needed_by, token_hash, status, created_at)
    values (${r.id}, ${r.party_id}, ${r.host_id}, ${r.suggestion_id}, ${JSON.stringify(r.vendor)}, ${r.need}, ${r.budget_line}, ${r.needed_by}, ${r.token_hash}, 'draft', ${r.created_at})`;
  return { request: r, token };
}

export async function markSent(id: string, channel: "email" | "link") {
  const now = new Date().toISOString();
  if (neonFallback()) { const r = table<VendorRequest>("vendor_requests").find((x) => x.id === id); if (r && r.status === "draft") Object.assign(r, { status: "sent", channel, sent_at: now }); return; }
  await sql()`update vendor_requests set status = case when status = 'draft' then 'sent' else status end, channel = ${channel}, sent_at = coalesce(sent_at, ${now}) where id = ${id}`;
}

// Rotating the link: a new token, old one dead. Used when re-sending.
export async function rotateToken(id: string): Promise<string> {
  const token = newToken();
  if (neonFallback()) { const r = table<VendorRequest>("vendor_requests").find((x) => x.id === id); if (r) { r.token_hash = hashToken(token); r.token_revoked_at = null; } return token; }
  await sql()`update vendor_requests set token_hash = ${hashToken(token)}, token_revoked_at = null where id = ${id}`;
  return token;
}

export async function patchRequest(partyId: string, hostId: string, id: string, body: z.infer<typeof RequestPatchBody>): Promise<VendorRequest | { error: string }> {
  const r = await getRequest(partyId, hostId, id);
  if (!r) return { error: "not found" };
  const now = new Date().toISOString();
  if (body.status === "accepted" && !["quoted", "sent"].includes(r.status)) return { error: `cannot accept a ${r.status} request` };
  if (neonFallback()) {
    if (body.status === "accepted") for (const o of table<VendorRequest>("vendor_requests")) if (o.party_id === partyId && o.vendor.category === r.vendor.category && o.status === "accepted") Object.assign(o, { status: "closed", decided_at: now });
    if (body.status) Object.assign(r, { status: body.status, decided_at: now });
    if (body.revoke_link) r.token_revoked_at = now;
    return r;
  }
  const q = sql();
  if (body.status === "accepted") await q`update vendor_requests set status = 'closed', decided_at = ${now} where party_id = ${partyId} and host_id = ${hostId} and status = 'accepted' and vendor->>'category' = ${r.vendor.category} and id <> ${id}`;
  if (body.status) await q`update vendor_requests set status = ${body.status}, decided_at = ${now} where id = ${id} and party_id = ${partyId} and host_id = ${hostId}`;
  if (body.revoke_link) await q`update vendor_requests set token_revoked_at = ${now} where id = ${id} and party_id = ${partyId} and host_id = ${hostId}`;
  return (await getRequest(partyId, hostId, id))!;
}

export async function listReplies(requestIds: string[]): Promise<VendorReply[]> {
  if (!requestIds.length) return [];
  if (neonFallback()) return table<VendorReply>("vendor_replies").filter((r) => requestIds.includes(r.request_id)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows = await sql()`select * from vendor_replies where request_id = any(${requestIds}::uuid[]) order by created_at desc`;
  return (rows as Record<string, unknown>[]).map(fixReply);
}

// ---------- the vendor side (token-scoped, like a guest invite) ----------

export type RequestCtx = { request: VendorRequest; party: Party; replies: VendorReply[] };

export async function loadRequestByToken(token: string, loadParty: (id: string) => Promise<Party | null>): Promise<RequestCtx | null> {
  if (!looksLikeToken(token)) return null;
  const h = hashToken(token);
  let r: VendorRequest | undefined;
  if (neonFallback()) r = table<VendorRequest>("vendor_requests").find((x) => x.token_hash === h);
  else { const rows = await sql()`select * from vendor_requests where token_hash = ${h} limit 1`; r = (rows as Record<string, unknown>[]).map(fixReq)[0]; }
  if (!r || r.token_revoked_at) return null;
  const party = await loadParty(r.party_id);
  if (!party) return null;
  const replies = await listReplies([r.id]);
  return { request: r, party, replies };
}

type WriteMeta = { channel: "api" | "web" | "email"; idempotency_key?: string | null; defaultKind?: "agent" | "human"; source?: "api" | "fast" | "llm"; raw_text?: string; evidence?: string; confidence?: number };

async function insertReply(r: VendorReply): Promise<{ ok: true } | { error: string }> {
  if (neonFallback()) {
    const t = table<VendorReply>("vendor_replies");
    if (r.idempotency_key && t.some((x) => x.request_id === r.request_id && x.idempotency_key === r.idempotency_key)) return { ok: true };
    t.push(r); return { ok: true };
  }
  try {
    await sql()`insert into vendor_replies (id, request_id, kind, price, currency, available, alternative, lead_time_days, notes, valid_until, raw_text, evidence, confidence, source, by_kind, by_name, channel, idempotency_key, created_at)
      values (${r.id}, ${r.request_id}, ${r.kind}, ${r.price}, ${r.currency}, ${r.available}, ${r.alternative}, ${r.lead_time_days}, ${r.notes}, ${r.valid_until}, ${r.raw_text}, ${r.evidence}, ${r.confidence}, ${r.source}, ${r.by_kind}, ${r.by_name}, ${r.channel}, ${r.idempotency_key}, ${r.created_at})`;
  } catch (e) {
    if (!/duplicate key/i.test((e as Error).message)) return { error: (e as Error).message };
  }
  return { ok: true };
}

async function setStatusFromReply(id: string, kind: VendorReply["kind"]) {
  const next = kind === "quote" ? "quoted" : kind === "decline" ? "declined" : null;
  if (!next) return;
  if (neonFallback()) { const r = table<VendorRequest>("vendor_requests").find((x) => x.id === id); if (r && ["draft", "sent", "quoted"].includes(r.status)) r.status = next; return; }
  await sql()`update vendor_requests set status = ${next} where id = ${id} and status in ('draft','sent','quoted')`;
}

const base = (ctx: RequestCtx, kind: VendorReply["kind"], meta: WriteMeta, by?: { kind: "agent" | "human"; name?: string }): VendorReply => ({
  id: randomUUID(), request_id: ctx.request.id, kind, price: null, currency: "usd", available: null, alternative: null, lead_time_days: null, notes: null, valid_until: null,
  raw_text: meta.raw_text ?? null, evidence: meta.evidence ?? null, confidence: meta.confidence ?? null, source: meta.source ?? "api",
  by_kind: by?.kind ?? meta.defaultKind ?? "human", by_name: by?.name ?? null, channel: meta.channel, idempotency_key: meta.idempotency_key ?? null, created_at: new Date().toISOString(),
});

export async function writeQuote(ctx: RequestCtx, body: z.input<typeof QuoteBody>, meta: WriteMeta) {
  if (["accepted", "closed"].includes(ctx.request.status)) return { error: `this request is ${ctx.request.status}; the host is no longer collecting quotes` };
  const r = { ...base(ctx, "quote", meta, body.by), price: body.price, currency: (body.currency ?? "usd").toLowerCase(), available: body.available, alternative: body.alternative ?? null, lead_time_days: body.lead_time_days ?? null, notes: body.notes ?? null, valid_until: body.valid_until ?? null };
  const w = await insertReply(r); if ("error" in w) return w;
  await setStatusFromReply(ctx.request.id, "quote");
  return { ok: true as const };
}
export async function writeVendorMessage(ctx: RequestCtx, body: z.infer<typeof VendorMessageBody>, meta: WriteMeta) {
  const r = { ...base(ctx, "message", meta, body.by), notes: body.text };
  return insertReply(r);
}
export async function writeDecline(ctx: RequestCtx, body: z.infer<typeof DeclineBody>, meta: WriteMeta) {
  const r = { ...base(ctx, "decline", meta, body.by), available: "no" as const, notes: body.reason ?? null };
  const w = await insertReply(r); if ("error" in w) return w;
  await setStatusFromReply(ctx.request.id, "decline");
  return { ok: true as const };
}

// ---------- the request document (what a vendor's agent reads) ----------

export function requestJson(ctx: RequestCtx, token: string) {
  const { request: r, party, replies } = ctx;
  const b = `${siteUrl()}/v/${token}`;
  const latest = replies[0];
  const doc: Record<string, unknown> = {
    indbyagent: SPEC_VERSION,
    kind: "vendor_request",
    party: { title: party.title, starts_at: party.starts_at ?? undefined, date: party.starts_at ? undefined : "tbd", timezone: party.timezone, area: party.location ?? undefined },
    request: { category: r.vendor.category, need: r.need, budget_line: r.budget_line ?? undefined, needed_by: r.needed_by ?? undefined, status: r.status },
    vendor: { name: r.vendor.name },
    your_reply: latest ? { kind: latest.kind, price: latest.price ?? undefined, available: latest.available ?? undefined, notes: latest.notes ?? undefined, at: latest.created_at } : undefined,
    actions: { quote: `POST ${b}/quote`, question: `POST ${b}/message`, decline: `POST ${b}/decline` },
    schema: {
      quote: { price: "number (major units, e.g. 120.00)", currency: "ISO 4217, default usd", available: "yes|no|alternative", alternative: "ISO datetime when available=alternative", lead_time_days: "int", notes: "string", valid_until: "YYYY-MM-DD", by: { kind: "agent|human", name: "string" } },
      message: { text: "string", by: "same" },
      decline: { reason: "string", by: "same" },
    },
    rules: "A quote is not a booking. The host confirms in writing before anything is reserved or paid. GET never changes anything. Send an Idempotency-Key header to make retries safe.",
  };
  return JSON.parse(JSON.stringify(doc)); // drops undefined
}

export function requestText(ctx: RequestCtx, token: string): string {
  const { request: r, party } = ctx;
  const b = `${siteUrl()}/v/${token}`;
  const when = party.starts_at ? fmtDate(party.starts_at, party.timezone) : "date TBD";
  return [
    `IndbyAgent vendor request v${SPEC_VERSION}`,
    `${r.vendor.name}: a host is asking for a quote.`,
    `Party: ${party.title} · ${when}${party.location ? ` · ${party.location}` : ""}`,
    `Need (${r.vendor.category}): ${r.need}`,
    r.budget_line ? `Budget line: ${r.budget_line}` : null,
    r.needed_by ? `Needed by: ${r.needed_by}` : null,
    `Status: ${r.status}`,
    ``,
    `Reply as an agent (replace values):`,
    `curl -s ${b}.json`,
    `curl -s -X POST ${b}/quote -H 'content-type: application/json' \\`,
    `  -d '{"price":120,"currency":"usd","available":"yes","lead_time_days":3,"notes":"nut-free is fine","by":{"kind":"agent","name":"YOUR_AGENT"}}'`,
    `curl -s -X POST ${b}/message -H 'content-type: application/json' -d '{"text":"...","by":{"kind":"agent","name":"YOUR_AGENT"}}'`,
    `curl -s -X POST ${b}/decline -H 'content-type: application/json' -d '{"reason":"booked that day","by":{"kind":"agent","name":"YOUR_AGENT"}}'`,
    `Rules: a quote is not a booking; the host confirms before anything is reserved or paid. GET never changes anything.`,
  ].filter((l) => l !== null).join("\n") + "\n";
}
