import crypto from "crypto";
import { AgentMailClient } from "agentmail";
import { db } from "./db";
import { siteUrl, newToken, hashToken } from "./token";

// "Use your own inbox": IndbyAgent signs the subscriber up for their own
// AgentMail account (AgentMail's agent sign-up API, in the subscriber's name).
// AgentMail emails them a 6-digit code; once verified, their parties send from
// that account. The account is theirs and they can claim it in AgentMail's console.

export type MailAccount = { email: string; org_id: string; inbox_id: string; api_key_enc: string; status: "pending" | "verified"; webhook_id: string | null };

function key(): Buffer {
  const s = process.env.MAIL_KEY_SECRET;
  if (!s) throw new Error("MAIL_KEY_SECRET is not set");
  return crypto.createHash("sha256").update(s).digest();
}
export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
export function unseal(sealed: string): string {
  const [iv, tag, enc] = sealed.split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

const norm = (e: string) => e.trim().toLowerCase();

export async function accountFor(email: string | null | undefined): Promise<MailAccount | null> {
  if (!email) return null;
  const { data } = await db.from("mail_accounts").select("*").eq("email", norm(email)).maybeSingle();
  return (data as MailAccount) ?? null;
}

// AgentMail client for an inbox: the subscriber's own key if it is theirs, else null.
export async function ownClientForInbox(inboxId: string): Promise<AgentMailClient | null> {
  const { data } = await db.from("mail_accounts").select("api_key_enc").eq("inbox_id", inboxId).maybeSingle();
  return data ? new AgentMailClient({ apiKey: unseal(data.api_key_enc as string) }) : null;
}

// The account a host may send from: linked explicitly, or a signed-in host
// (email proven by magic link) whose email owns a verified account.
export async function accountForHost(host: { id: string; email: string | null; auth_user_id?: string | null }): Promise<MailAccount | null> {
  const { data: link } = await db.from("mail_account_hosts").select("email").eq("host_id", host.id).maybeSingle();
  if (link) return accountFor(link.email as string);
  if (host.auth_user_id && host.email) {
    const a = await accountFor(host.email);
    if (a?.status === "verified") { await db.from("mail_account_hosts").upsert({ host_id: host.id, email: a.email }); return a; }
  }
  return null;
}

export async function linkHostByToken(hostId: string, token: string) {
  const { data } = await db.from("mail_accounts").select("email,inbox_id").eq("inbox_token_hash", hashToken(token.trim())).maybeSingle();
  if (!data) return null;
  await db.from("mail_account_hosts").upsert({ host_id: hostId, email: data.email });
  return { inbox: data.inbox_id as string, status: "verified" as const };
}

export async function startOwnInbox(email: string, username: string) {
  const e = norm(email);
  const existing = await accountFor(e);
  // Never call sign-up again for a verified account: it would rotate its key.
  if (existing?.status === "verified") return { error: "this email already has a verified inbox; send { inbox_token } to use it" };
  const anon = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY ?? "" });
  const r = await anon.agent.signUp({ humanEmail: e, username, source: "indbyagent" });
  await db.from("mail_accounts").upsert({ email: e, org_id: r.organizationId, inbox_id: r.inboxId, api_key_enc: seal(r.apiKey), status: "pending" });
  return { inbox: r.inboxId, status: "pending" as const };
}

export async function verifyOwnInbox(email: string, otp: string, hostId: string) {
  const acct = await accountFor(email);
  if (!acct) return { error: "no inbox started for this email" };
  if (acct.status === "verified") return { error: "already verified; send { inbox_token } to use it" };
  const c = new AgentMailClient({ apiKey: unseal(acct.api_key_enc) });
  const v = await c.agent.verify({ otpCode: otp.trim() });
  if (!v.verified) return { error: "code not accepted" };
  // Replies to the subscriber's inbox come to the same IndbyAgent webhook.
  let webhookId = acct.webhook_id;
  if (!webhookId) {
    const secret = process.env.AGENTMAIL_WEBHOOK_SECRET ?? "";
    const url = `${siteUrl()}/api/webhooks/agentmail${secret ? `?secret=${encodeURIComponent(secret)}` : ""}`;
    const w = await c.webhooks.create({ url, eventTypes: ["message.received"], inboxIds: [acct.inbox_id] } as never).catch(() => null);
    webhookId = (w as { webhookId?: string } | null)?.webhookId ?? null;
  }
  const inboxToken = "ibx_" + newToken();
  await db.from("mail_accounts").update({ status: "verified", verified_at: new Date().toISOString(), webhook_id: webhookId, inbox_token_hash: hashToken(inboxToken) }).eq("email", acct.email);
  await db.from("mail_account_hosts").upsert({ host_id: hostId, email: acct.email });
  return { inbox: acct.inbox_id, status: "verified" as const, webhook: !!webhookId, inbox_token: inboxToken };
}

// AgentMail refuses a send for plan or ramp limits with 403/429.
export function isLimitError(e: unknown): boolean {
  const x = e as { statusCode?: number; body?: { name?: string; code?: string } };
  return x?.statusCode === 429 || x?.statusCode === 403 || /limit/i.test(String(x?.body?.name ?? x?.body?.code ?? ""));
}
