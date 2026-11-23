"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supaBrowser } from "@/lib/supabase-browser";

type Key = { id: string; label: string; key_prefix: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null };
type Me = { email: string | null; keys: Key[]; usage_30d: { calls: Record<string, number>; active_members: number } };

const day = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "never");

export default function Console() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [err, setErr] = useState("");
  const busy = useRef(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/builder/keys", { credentials: "same-origin" });
    if (r.status === 401) { setMe(null); return; }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "Couldn't load your keys");
    setMe(j);
  }, []);

  useEffect(() => { load().catch((e) => setErr(e.message)).finally(() => setChecking(false)); }, [load]);

  const sendLink = async () => {
    const addr = email.trim().toLowerCase();
    if (!addr || busy.current) return;
    busy.current = true; setErr("");
    try {
      const { error } = await supaBrowser().auth.signInWithOtp({ email: addr, options: { emailRedirectTo: `${window.location.origin}/build` } });
      if (error && !/database error saving new user/i.test(error.message)) setErr(error.message); else setSent(true);
    } finally { busy.current = false; }
  };
  const create = async () => {
    setErr("");
    const r = await fetch("/api/builder/keys", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: label || "default" }) });
    const j = await r.json();
    if (!r.ok) { setErr(j.error ?? "Couldn't create a key"); return; }
    setFresh(j.key); setLabel(""); load();
  };
  const revoke = async (id: string) => {
    setErr("");
    const r = await fetch(`/api/builder/keys?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
    if (!r.ok) setErr((await r.json()).error ?? "Couldn't revoke"); else load();
  };

  if (checking) return <p className="text-sm text-neutral-500">Loading…</p>;

  if (!me) return (
    <div className="space-y-3">
      {sent ? <p className="text-neutral-300">Check <b>{email}</b> for a sign-in link. It brings you back here.</p> : (<>
        <p className="text-sm text-neutral-400">Sign in with your email to get an API key. No password, no card.</p>
        <div className="flex gap-2">
          <input className="min-w-0 flex-1 rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendLink()} />
          <button onClick={sendLink} className="rounded-md bg-white text-neutral-900 px-4 py-2 font-medium">Get a key</button>
        </div>
      </>)}
      {err && <p className="text-sm text-red-400">{err}</p>}
    </div>
  );

  const live = me.keys.filter((k) => !k.revoked_at);
  return (
    <div className="space-y-5">
      <p className="text-sm text-neutral-400">Signed in as {me.email}. Last 30 days: {Object.values(me.usage_30d.calls).reduce((a, b) => a + b, 0)} calls, {me.usage_30d.active_members} members planned for.</p>
      {fresh && (
        <div className="rounded-md border border-emerald-700 bg-emerald-950/40 p-3 space-y-2">
          <p className="text-sm text-emerald-300">Your new key. Copy it now; it won&apos;t be shown again. Keep it on your server, never in a browser.</p>
          <code className="block break-all rounded bg-neutral-950 p-2 text-sm">{fresh}</code>
          <button onClick={() => navigator.clipboard?.writeText(fresh)} className="text-sm underline">Copy</button>
        </div>
      )}
      <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
        {me.keys.length === 0 && <li className="p-3 text-sm text-neutral-500">No keys yet.</li>}
        {me.keys.map((k) => (
          <li key={k.id} className="flex items-center justify-between gap-3 p-3 text-sm">
            <div className="min-w-0">
              <div className="font-medium">{k.label} <span className="font-mono text-neutral-500">{k.key_prefix}…</span></div>
              <div className="text-neutral-500">{k.revoked_at ? `revoked ${day(k.revoked_at)}` : `created ${day(k.created_at)} · last used ${day(k.last_used_at)}`}</div>
            </div>
            {!k.revoked_at && <button onClick={() => revoke(k.id)} className="shrink-0 text-red-400 hover:underline">Revoke</button>}
          </li>
        ))}
      </ul>
      {live.length < 3 && (
        <div className="flex gap-2">
          <input className="min-w-0 flex-1 rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm" placeholder="Label (e.g. production)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button onClick={create} className="rounded-md bg-white text-neutral-900 px-4 py-2 text-sm font-medium">Create key</button>
        </div>
      )}
      {err && <p className="text-sm text-red-400">{err}</p>}
    </div>
  );
}
