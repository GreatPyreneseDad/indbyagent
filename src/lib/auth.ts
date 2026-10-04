import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { db } from "./db";
import { safeEqual } from "./token";
import { fallback } from "./fallback";

const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000001";

export type Host = { id: string; auth_user_id: string | null; name: string; email: string | null };

// Server-side Supabase client bound to the request's auth cookies.
export async function supaServer() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (all) => { try { all.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {} },
    },
  });
}

// Who is the host making this request?
// 1) A signed-in Supabase user (magic link) -> their hosts row (created on first sign-in).
// 2) Bearer HOST_SECRET (ops/scripts) -> the first host row.
export async function currentHost(req?: NextRequest): Promise<Host | null> {
  const s = process.env.HOST_SECRET;
  const bearer = req?.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (s && bearer && safeEqual(bearer, s)) {
    const { data } = await db.from("hosts").select("*").order("created_at").limit(1).maybeSingle();
    return (data as Host) ?? null;
  }
  if (fallback.db) {
    const { data: h } = await db.from("hosts").select("*").eq("auth_user_id", LOCAL_USER_ID).maybeSingle();
    if (h) return h as Host;
    const { data: created } = await db.from("hosts").insert({ auth_user_id: LOCAL_USER_ID, email: "tester@localhost", name: "Local tester" }).select().single();
    return (created as Host) ?? null;
  }
  const supa = await supaServer();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return null;
  const { data: h } = await db.from("hosts").select("*").eq("auth_user_id", user.id).maybeSingle();
  if (h) return h as Host;
  const { data: created } = await db.from("hosts").insert({ auth_user_id: user.id, email: user.email ?? null, name: user.email?.split("@")[0] ?? "Host" }).select().single();
  return (created as Host) ?? null;
}

export async function hostOwnsParty(host: Host, partyId: string): Promise<boolean> {
  const { data } = await db.from("parties").select("id").eq("id", partyId).eq("host_id", host.id).maybeSingle();
  return !!data;
}
