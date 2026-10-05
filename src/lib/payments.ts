import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, neonFallback, table } from "./neon";
import type { VendorRequest } from "./vendor-requests";

// Host-authorized payments. The shape of the rule:
//   1. The HOST creates an authorization: one vendor request, a hard cap, a
//      currency, an expiry, and (optionally) a provider-side payment method
//      reference they set up with the provider themselves.
//   2. An agent (or the host) may then EXECUTE a payment inside that envelope:
//      amount <= cap, before expiry, request status 'accepted', not revoked,
//      cap not already consumed. Anything else is refused and recorded.
//   3. Providers do the moving of money. "manual" records the intent and tells
//      the host to pay directly; "stripe" charges a saved payment method
//      off-session when STRIPE_SECRET_KEY is set. This code never sees card data.
// Every attempt, including refusals, is a row in payment_attempts.

export type Provider = "manual" | "stripe";
export type Authorization = {
  id: string; party_id: string; host_id: string; request_id: string;
  max_amount_cents: number; currency: string; provider: Provider; payment_method_ref: string | null; purpose: string | null;
  expires_at: string; revoked_at: string | null; created_at: string;
};
export type AttemptStatus = "pending_offline" | "requires_action" | "succeeded" | "failed" | "refused";
export type Attempt = {
  id: string; authorization_id: string; request_id: string; amount_cents: number; currency: string; provider: Provider;
  provider_ref: string | null; status: AttemptStatus; reason: string | null; by_kind: "agent" | "human"; by_name: string | null;
  idempotency_key: string | null; created_at: string;
};

export const AuthorizeBody = z.object({
  request_id: z.string().uuid(),
  max_amount: z.number().positive().max(100_000),            // major units; stored as cents
  currency: z.string().trim().length(3).default("usd"),
  provider: z.enum(["manual", "stripe"]).default("manual"),
  payment_method_ref: z.string().trim().max(200).optional(),  // e.g. a Stripe pm_… the host attached via the provider's UI
  purpose: z.string().trim().max(200).optional(),
  expires_in_hours: z.number().int().min(1).max(24 * 30).default(72),
}).strict();

export const ExecuteBody = z.object({
  amount: z.number().positive().max(100_000),
  currency: z.string().trim().length(3).optional(),
  note: z.string().trim().max(200).optional(),
  by: z.object({ kind: z.enum(["agent", "human"]), name: z.string().trim().max(80).optional() }).optional(),
}).strict();

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const fixAuth = (r: Record<string, unknown>): Authorization => ({ ...(r as Authorization), expires_at: iso(r.expires_at)!, revoked_at: iso(r.revoked_at), created_at: iso(r.created_at)! });
const fixAttempt = (r: Record<string, unknown>): Attempt => ({ ...(r as Attempt), created_at: iso(r.created_at)! });

// ---------- storage ----------

export async function listAuthorizations(partyId: string, hostId: string): Promise<Authorization[]> {
  if (neonFallback()) return table<Authorization>("payment_authorizations").filter((a) => a.party_id === partyId && a.host_id === hostId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows = await sql()`select * from payment_authorizations where party_id = ${partyId} and host_id = ${hostId} order by created_at desc`;
  return (rows as Record<string, unknown>[]).map(fixAuth);
}

export async function listAttempts(authorizationIds: string[]): Promise<Attempt[]> {
  if (!authorizationIds.length) return [];
  if (neonFallback()) return table<Attempt>("payment_attempts").filter((a) => authorizationIds.includes(a.authorization_id)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows = await sql()`select * from payment_attempts where authorization_id = any(${authorizationIds}::uuid[]) order by created_at desc`;
  return (rows as Record<string, unknown>[]).map(fixAttempt);
}

export async function authorize(partyId: string, hostId: string, request: VendorRequest, body: z.input<typeof AuthorizeBody>): Promise<Authorization | { error: string }> {
  if (request.status !== "accepted") return { error: `payments can only be authorized for an accepted request (this one is ${request.status})` };
  const provider = body.provider ?? "manual", currency = (body.currency ?? "usd").toLowerCase(), hours = body.expires_in_hours ?? 72;
  if (provider === "stripe" && !process.env.STRIPE_SECRET_KEY) return { error: "stripe is not configured on this deployment (STRIPE_SECRET_KEY); use provider 'manual'" };
  if (provider === "stripe" && !body.payment_method_ref) return { error: "stripe authorizations need payment_method_ref (a saved payment method the host attached through Stripe)" };
  const a: Authorization = {
    id: randomUUID(), party_id: partyId, host_id: hostId, request_id: request.id,
    max_amount_cents: Math.round(body.max_amount * 100), currency, provider,
    payment_method_ref: body.payment_method_ref ?? null, purpose: body.purpose ?? null,
    expires_at: new Date(Date.now() + hours * 3600e3).toISOString(), revoked_at: null, created_at: new Date().toISOString(),
  };
  if (neonFallback()) { table<Authorization>("payment_authorizations").push(a); return a; }
  await sql()`insert into payment_authorizations (id, party_id, host_id, request_id, max_amount_cents, currency, provider, payment_method_ref, purpose, expires_at, created_at)
    values (${a.id}, ${a.party_id}, ${a.host_id}, ${a.request_id}, ${a.max_amount_cents}, ${a.currency}, ${a.provider}, ${a.payment_method_ref}, ${a.purpose}, ${a.expires_at}, ${a.created_at})`;
  return a;
}

export async function revoke(partyId: string, hostId: string, id: string): Promise<Authorization | { error: string }> {
  const now = new Date().toISOString();
  if (neonFallback()) { const a = table<Authorization>("payment_authorizations").find((x) => x.id === id && x.party_id === partyId && x.host_id === hostId); if (!a) return { error: "not found" }; a.revoked_at = a.revoked_at ?? now; return a; }
  const rows = await sql()`update payment_authorizations set revoked_at = coalesce(revoked_at, ${now}) where id = ${id} and party_id = ${partyId} and host_id = ${hostId} returning *`;
  const a = (rows as Record<string, unknown>[]).map(fixAuth)[0];
  return a ?? { error: "not found" };
}

async function recordAttempt(t: Attempt): Promise<Attempt> {
  if (neonFallback()) {
    const tbl = table<Attempt>("payment_attempts");
    const dup = t.idempotency_key && tbl.find((x) => x.authorization_id === t.authorization_id && x.idempotency_key === t.idempotency_key);
    if (dup) return dup;
    tbl.push(t); return t;
  }
  try {
    await sql()`insert into payment_attempts (id, authorization_id, request_id, amount_cents, currency, provider, provider_ref, status, reason, by_kind, by_name, idempotency_key, created_at)
      values (${t.id}, ${t.authorization_id}, ${t.request_id}, ${t.amount_cents}, ${t.currency}, ${t.provider}, ${t.provider_ref}, ${t.status}, ${t.reason}, ${t.by_kind}, ${t.by_name}, ${t.idempotency_key}, ${t.created_at})`;
  } catch (e) {
    if (/duplicate key/i.test((e as Error).message)) {
      const rows = await sql()`select * from payment_attempts where authorization_id = ${t.authorization_id} and idempotency_key = ${t.idempotency_key} limit 1`;
      return (rows as Record<string, unknown>[]).map(fixAttempt)[0];
    }
    throw e;
  }
  return t;
}

// ---------- the envelope check ----------

export type Envelope = { ok: true; remaining_cents: number } | { ok: false; reason: string };

export async function checkEnvelope(a: Authorization, request: VendorRequest, amountCents: number, currency: string): Promise<Envelope> {
  if (a.revoked_at) return { ok: false, reason: "authorization revoked by the host" };
  if (new Date(a.expires_at).getTime() < Date.now()) return { ok: false, reason: `authorization expired at ${a.expires_at}` };
  if (request.status !== "accepted") return { ok: false, reason: `request is ${request.status}, not accepted` };
  if (currency !== a.currency) return { ok: false, reason: `authorization is in ${a.currency}, not ${currency}` };
  const spent = (await listAttempts([a.id])).filter((t) => t.status === "succeeded" || t.status === "pending_offline").reduce((s, t) => s + t.amount_cents, 0);
  const remaining = a.max_amount_cents - spent;
  if (amountCents > remaining) return { ok: false, reason: `amount ${amountCents} exceeds the remaining authorized ${remaining} (cap ${a.max_amount_cents} ${a.currency})` };
  return { ok: true, remaining_cents: remaining - amountCents };
}

// ---------- providers ----------

type ProviderResult = { status: AttemptStatus; provider_ref: string | null; reason: string | null };

async function manualProvider(a: Authorization, request: VendorRequest, amountCents: number): Promise<ProviderResult> {
  const v = request.vendor;
  const how = [v.email ? `email ${v.email}` : null, v.phone ? `call ${v.phone}` : null, v.url ? `see ${v.url}` : null].filter(Boolean).join(" or ") || "contact the vendor";
  return { status: "pending_offline", provider_ref: null, reason: `Pay ${v.name} ${(amountCents / 100).toFixed(2)} ${a.currency.toUpperCase()} directly (${how}); mark it settled on the board.` };
}

// Stripe, off-session, against a payment method the host saved with Stripe.
// Scaffold: exercised only when STRIPE_SECRET_KEY is set. Uses the REST API
// directly so the dependency footprint stays zero.
async function stripeProvider(a: Authorization, request: VendorRequest, amountCents: number, idem: string | null): Promise<ProviderResult> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { status: "refused", provider_ref: null, reason: "STRIPE_SECRET_KEY not configured" };
  if (!a.payment_method_ref) return { status: "refused", provider_ref: null, reason: "no payment_method_ref on the authorization" };
  const [customer, pm] = a.payment_method_ref.includes(":") ? a.payment_method_ref.split(":", 2) : [null, a.payment_method_ref];
  const form = new URLSearchParams({
    amount: String(amountCents), currency: a.currency, confirm: "true", off_session: "true",
    payment_method: pm, description: `IndbyAgent: ${request.vendor.name} — ${a.purpose ?? request.need}`.slice(0, 250),
    "metadata[request_id]": request.id, "metadata[authorization_id]": a.id, "metadata[party_id]": request.party_id,
  });
  if (customer) form.set("customer", customer);
  const res = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", ...(idem ? { "Idempotency-Key": `${a.id}:${idem}` } : {}) },
    body: form,
  });
  const j = await res.json().catch(() => ({})) as { id?: string; status?: string; error?: { message?: string } };
  if (!res.ok) return { status: "failed", provider_ref: j.id ?? null, reason: j.error?.message ?? `stripe ${res.status}` };
  if (j.status === "succeeded") return { status: "succeeded", provider_ref: j.id ?? null, reason: null };
  if (j.status === "requires_action" || j.status === "requires_confirmation") return { status: "requires_action", provider_ref: j.id ?? null, reason: "the bank wants the host to confirm this payment (3-D Secure); the host completes it in Stripe" };
  return { status: "failed", provider_ref: j.id ?? null, reason: `stripe status ${j.status}` };
}

// ---------- execute ----------

export async function execute(a: Authorization, request: VendorRequest, body: z.infer<typeof ExecuteBody>, meta: { idempotency_key: string | null; defaultKind: "agent" | "human" }): Promise<Attempt> {
  const amountCents = Math.round(body.amount * 100);
  const currency = (body.currency ?? a.currency).toLowerCase();
  const by_kind = body.by?.kind ?? meta.defaultKind;
  const by_name = body.by?.name ?? null;
  const common = { id: randomUUID(), authorization_id: a.id, request_id: request.id, amount_cents: amountCents, currency, provider: a.provider, by_kind, by_name, idempotency_key: meta.idempotency_key, created_at: new Date().toISOString() };
  // Idempotent replay: same key returns the earlier attempt untouched.
  if (meta.idempotency_key) {
    const prior = (await listAttempts([a.id])).find((t) => t.idempotency_key === meta.idempotency_key);
    if (prior) return prior;
  }
  const env = await checkEnvelope(a, request, amountCents, currency);
  if (!env.ok) return recordAttempt({ ...common, provider_ref: null, status: "refused", reason: env.reason });
  const r = a.provider === "stripe" ? await stripeProvider(a, request, amountCents, meta.idempotency_key) : await manualProvider(a, request, amountCents);
  return recordAttempt({ ...common, provider_ref: r.provider_ref, status: r.status, reason: r.reason });
}

// The host marks an offline payment as done (manual provider only).
export async function settle(partyId: string, hostId: string, attemptId: string): Promise<Attempt | { error: string }> {
  const auths = await listAuthorizations(partyId, hostId);
  const t = (await listAttempts(auths.map((x) => x.id))).find((x) => x.id === attemptId);
  if (!t) return { error: "not found" };
  if (t.status !== "pending_offline") return { error: `attempt is ${t.status}` };
  if (neonFallback()) { t.status = "succeeded"; t.reason = "settled by host"; return t; }
  const rows = await sql()`update payment_attempts set status = 'succeeded', reason = 'settled by host' where id = ${attemptId} and status = 'pending_offline' returning *`;
  return (rows as Record<string, unknown>[]).map(fixAttempt)[0] ?? { error: "not found" };
}
