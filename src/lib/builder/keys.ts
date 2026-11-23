import { NextResponse, type NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";

// Builder API keys: "ibk_<random>". Only a SHA-256 hash is stored; the key is shown once.
export const KEY_PREFIX = "ibk_";
export const MAX_KEYS = 3;
export const CALLS_PER_HOUR = 600;
export const AI_PAIRS_PER_DAY = 500;

export type Builder = { keyId: string; hostId: string; scopes: string[] };
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function newKey() {
  const key = KEY_PREFIX + randomBytes(24).toString("base64url");
  return { key, prefix: key.slice(0, 12), hash: sha(key) };
}

export async function builderFromRequest(req: NextRequest, scope?: string): Promise<Builder | NextResponse> {
  const raw = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!raw.startsWith(KEY_PREFIX)) return NextResponse.json({ error: "missing_api_key", docs: "/build" }, { status: 401 });
  const { data: k } = await db.from("builder_api_keys").select("id, host_id, scopes, revoked_at").eq("key_hash", sha(raw)).maybeSingle();
  if (!k || k.revoked_at) return NextResponse.json({ error: "invalid_api_key" }, { status: 401 });
  if (scope && !(k.scopes as string[]).includes(scope)) return NextResponse.json({ error: "scope_not_allowed", scope }, { status: 403 });
  const { count } = await db.from("builder_api_usage").select("id", { count: "exact", head: true })
    .eq("key_id", k.id).gte("at", new Date(Date.now() - 3600e3).toISOString());
  if ((count ?? 0) >= CALLS_PER_HOUR) return NextResponse.json({ error: "rate_limited", limit_per_hour: CALLS_PER_HOUR }, { status: 429 });
  await db.from("builder_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", k.id);
  return { keyId: k.id as string, hostId: k.host_id as string, scopes: k.scopes as string[] };
}

// One row per call. Member ids are hashed per builder: we can count active
// members without holding anyone's member data.
export async function logUsage(b: Builder, endpoint: string, started: number, units: number, memberIds: string[], status: number, meta: Record<string, unknown> = {}) {
  const hashes = [...new Set(memberIds)].map((m) => sha(`${b.hostId}:${m}`).slice(0, 32));
  await db.from("builder_api_usage").insert({ key_id: b.keyId, host_id: b.hostId, endpoint, ms: Date.now() - started, units, status, member_hashes: hashes, meta });
}

export async function aiPairsToday(hostId: string) {
  const { data } = await db.from("builder_api_usage").select("meta").eq("host_id", hostId)
    .gte("at", new Date(Date.now() - 864e5).toISOString()).eq("endpoint", "carpool/match");
  return (data ?? []).reduce((s, r) => s + (Number((r.meta as { estimated?: number })?.estimated) || 0), 0);
}
