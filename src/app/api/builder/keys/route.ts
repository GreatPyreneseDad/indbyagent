import { NextRequest, NextResponse } from "next/server";
import { currentHost } from "@/lib/auth";
import { db } from "@/lib/db";
import { newKey, MAX_KEYS } from "@/lib/builder/keys";

// The builder console's own API (signed-in session): list, create, revoke keys.
export const dynamic = "force-dynamic";

async function me(req: NextRequest) {
  const host = await currentHost(req);
  if (!host || host.scope_party_id) return null;     // party-scoped agent tokens can't manage keys
  return host;
}

export async function GET(req: NextRequest) {
  const host = await me(req);
  if (!host) return NextResponse.json({ error: "sign_in_required" }, { status: 401 });
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const [{ data: keys }, { data: usage }, { data: active }] = await Promise.all([
    db.from("builder_api_keys").select("id, label, key_prefix, scopes, created_at, last_used_at, revoked_at").eq("host_id", host.id).order("created_at", { ascending: false }),
    db.from("builder_api_usage").select("endpoint, status").eq("host_id", host.id).gte("at", since).limit(50000),
    db.rpc("builder_active_members", { p_host: host.id, p_since: since }),
  ]);
  const calls: Record<string, number> = {};
  for (const u of usage ?? []) if ((u.status as number) < 400) calls[u.endpoint as string] = (calls[u.endpoint as string] ?? 0) + 1;
  return NextResponse.json({ email: host.email, keys: keys ?? [], usage_30d: { calls, active_members: active ?? 0 } });
}

export async function POST(req: NextRequest) {
  const host = await me(req);
  if (!host) return NextResponse.json({ error: "sign_in_required" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const label = String(body?.label ?? "default").slice(0, 40) || "default";
  const { count } = await db.from("builder_api_keys").select("id", { count: "exact", head: true }).eq("host_id", host.id).is("revoked_at", null);
  if ((count ?? 0) >= MAX_KEYS) return NextResponse.json({ error: `You can have ${MAX_KEYS} active keys. Revoke one first.` }, { status: 400 });
  const k = newKey();
  const { data, error } = await db.from("builder_api_keys").insert({ host_id: host.id, label, key_prefix: k.prefix, key_hash: k.hash })
    .select("id, label, key_prefix, scopes, created_at").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ key: k.key, ...data }, { status: 201 });   // shown once
}

export async function DELETE(req: NextRequest) {
  const host = await me(req);
  if (!host) return NextResponse.json({ error: "sign_in_required" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { data } = await db.from("builder_api_keys").update({ revoked_at: new Date().toISOString() })
    .eq("id", id).eq("host_id", host.id).is("revoked_at", null).select("id").maybeSingle();
  return data ? NextResponse.json({ revoked: id }) : NextResponse.json({ error: "not found" }, { status: 404 });
}
