"use client";
import { useCallback, useEffect, useState } from "react";
import { supaBrowser } from "@/lib/supabase-browser";

type Board = {
  party: { id: string; title: string; starts_at: string; location: string | null; inbox_address: string | null };
  summary: { invited: number; yes: number; no: number; maybe: number; needs_human: number; pending: number; headcount: number; by_agent: number; by_human: number };
  guests: { guest_id: string; name: string; email: string | null; status: string | null; party_size: number | null; dietary: string[] | null; note: string | null; by_kind: string | null; by_name: string | null; channel: string | null; answered_at: string | null }[];
  polls: { id: string; question: string; options: string[]; status: string; counts: Record<string, number>; answers: { guest_id: string; choice: string; by_kind: string; by_name: string | null; channel: string }[] }[];
  messages: { id: string; guest_id: string | null; direction: string; text: string; by_kind: string; by_name: string | null; channel: string; created_at: string }[];
  tokens: { in: number; cached: number; out: number };
};

export default function Host() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [parties, setParties] = useState<{ id: string; title: string }[]>([]);
  const [partyId, setPartyId] = useState<string>("");
  const [board, setBoard] = useState<Board | null>(null);
  const [links, setLinks] = useState<{ name: string; invite_url: string }[]>([]);
  const [join, setJoin] = useState<{ join_url: string; screen_url: string } | null>(null);
  const [err, setErr] = useState("");

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const r = await fetch(path, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? (j.issues ?? []).join("; ") ?? r.statusText);
    return j;
  }, []);

  // On load: if a session cookie exists, we're in.
  useEffect(() => {
    if (window.location.hash.includes("access_token")) return; // SessionCatch handles this and reloads
    (async () => {
      try {
        const { data: { user } } = await supaBrowser().auth.getUser();
        if (!user) return;
        setMe(user.email ?? null);
        const j = await api("/api/host/parties"); setParties(j.parties); setAuthed(true); if (j.parties[0]) setPartyId(j.parties[0].id);
      } catch (e) { setErr((e as Error).message); }
    })();
    const q = new URLSearchParams(window.location.search); if (q.get("error")) setErr(q.get("error")!);
  }, [api]);

  const sendLink = async () => {
    setErr("");
    const { error } = await supaBrowser().auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/host` } });
    if (error) setErr(error.message); else setSent(true);
  };

  const refresh = useCallback(async () => {
    if (!partyId) return;
    try {
      fetch(`/api/host/parties/${partyId}/inbox`, { method: "POST", credentials: "same-origin" }).catch(() => {});
      setBoard(await api(`/api/host/parties/${partyId}/board`));
    } catch (e) { setErr((e as Error).message); }
  }, [api, partyId]);

  useEffect(() => { if (!authed || !partyId) return; refresh(); const t = setInterval(refresh, 2500); return () => clearInterval(t); }, [authed, partyId, refresh]);

  const createParty = async (f: FormData) => {
    setErr("");
    const starts = new Date(String(f.get("starts_at"))).toISOString();
    try {
      const j = await api("/api/host/parties", { method: "POST", body: JSON.stringify({ title: f.get("title"), starts_at: starts, location: f.get("location") || undefined, details: f.get("details") || undefined, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
      setParties((p) => [j.party, ...p]); setPartyId(j.party.id);
    } catch (e) { setErr((e as Error).message); }
  };
  const addGuests = async (f: FormData) => {
    setErr("");
    const guests = String(f.get("guests")).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, email, max] = l.split(",").map((s) => s.trim());
      return { name, email: email || undefined, party_size_max: Number(max) || 1 };
    });
    try { const j = await api(`/api/host/parties/${partyId}/guests`, { method: "POST", body: JSON.stringify({ guests }) }); setLinks((l) => [...j.guests, ...l]); refresh(); }
    catch (e) { setErr((e as Error).message); }
  };
  const addPoll = async (f: FormData) => {
    setErr("");
    try { await api(`/api/host/parties/${partyId}/polls`, { method: "POST", body: JSON.stringify({ question: f.get("question"), options: String(f.get("options")).split(",").map((s) => s.trim()).filter(Boolean) }) }); refresh(); }
    catch (e) { setErr((e as Error).message); }
  };
  const makeQr = async () => {
    setErr("");
    try { const j = await api(`/api/host/parties/${partyId}/join`, { method: "POST", body: "{}" }); setJoin(j); window.open(j.screen_url, "_blank"); }
    catch (e) { setErr((e as Error).message); }
  };
  const sendInvites = async () => {
    setErr("");
    try { const j = await api(`/api/host/parties/${partyId}/invites`, { method: "POST", body: "{}" }); alert(`Sent ${j.sent} invite(s) from ${j.from}`); refresh(); }
    catch (e) { setErr((e as Error).message); }
  };

  if (!authed) return (
    <main className="mx-auto max-w-sm px-4 py-24 space-y-4">
      <div className="text-xs tracking-[.14em] uppercase text-neutral-500">IndbyAgent</div>
      <h1 className="text-2xl font-semibold">Host a party</h1>
      {sent ? (
        <p className="text-neutral-300">Check <b>{email}</b> for a sign-in link. It brings you straight to your board.</p>
      ) : (
        <>
          <p className="text-sm text-neutral-400">No password. We email you a link.</p>
          <input className="w-full rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendLink()} />
          <button onClick={sendLink} className="rounded-md bg-white text-neutral-900 px-4 py-2 font-medium">Email me a sign-in link</button>
        </>
      )}
      {err && <p className="text-sm text-red-400">{err}</p>}
    </main>
  );

  const s = board?.summary;
  const pill = (k: string | null) => ({ yes: "text-emerald-400", no: "text-red-400", maybe: "text-amber-300", needs_human: "text-amber-300" }[k ?? ""] ?? "text-neutral-500");

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 space-y-8">
      <header className="flex flex-wrap items-center gap-3">
        <div className="text-xs tracking-[.14em] uppercase text-neutral-500">IndbyAgent · host{me ? ` · ${me}` : ""}</div>
        <form action="/auth/signout" method="post"><button className="text-xs text-neutral-500 underline">sign out</button></form>
        <select className="ml-auto rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" value={partyId} onChange={(e) => { setPartyId(e.target.value); setLinks([]); }}>
          {parties.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          <option value="">+ new party…</option>
        </select>
      </header>
      {err && <p className="text-sm text-red-400">{err}</p>}

      {!partyId && (
        <form action={createParty} className="grid gap-3 max-w-lg rounded-lg border border-neutral-800 p-4">
          <h2 className="font-semibold">New party</h2>
          <input name="title" required placeholder="Maya's 6th Birthday" className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" />
          <input name="starts_at" type="datetime-local" required className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" />
          <input name="location" placeholder="Dolores Park playground" className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" />
          <textarea name="details" placeholder="Dinosaur theme. Pizza and cake." className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" />
          <button className="rounded-md bg-white text-neutral-900 px-4 py-2 font-medium w-fit">Create</button>
        </form>
      )}

      {board && s && (
        <>
          <section>
            <h1 className="text-3xl font-bold tracking-tight">{board.party.title}</h1>
            <div className="text-neutral-400 text-sm">{new Date(board.party.starts_at).toLocaleString()} {board.party.location ? `· ${board.party.location}` : ""} {board.party.inbox_address ? `· ${board.party.inbox_address}` : ""}</div>
          </section>

          <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[["Invited", s.invited], ["Yes", s.yes], ["Headcount", s.headcount], ["Waiting on human", s.needs_human], ["Pending", s.pending]].map(([k, v]) => (
              <div key={String(k)} className="rounded-lg border border-neutral-800 p-3"><div className="text-xs text-neutral-500">{k}</div><div className="text-2xl font-semibold tabular-nums">{v}</div></div>
            ))}
          </section>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={makeQr} className="rounded-md bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 font-medium">Show QR on the big screen</button>
            {join && <a className="text-sm underline decoration-rose-500" href={join.join_url} target="_blank">{join.join_url.replace(/^https?:\/\//, "")}</a>}
          </div>
          <div className="text-sm text-neutral-400">
            Answered by agents: <b className="text-rose-400">{s.by_agent}</b> · by humans: <b>{s.by_human}</b> · Claude tokens spent on this party: <b className="tabular-nums">{board.tokens.in + board.tokens.out}</b> ({board.tokens.cached} cached)
          </div>

          <section className="rounded-lg border border-neutral-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-neutral-400 text-left"><tr><th className="p-2">Guest</th><th className="p-2">RSVP</th><th className="p-2">Size</th><th className="p-2">Dietary</th><th className="p-2">Note</th><th className="p-2">Answered by</th></tr></thead>
              <tbody>
                {board.guests.map((g) => (
                  <tr key={g.guest_id} className="border-t border-neutral-800">
                    <td className="p-2">{g.name}<div className="text-xs text-neutral-500">{g.email}</div></td>
                    <td className={`p-2 font-medium ${pill(g.status)}`}>{(g.status ?? "pending").replace("_", " ")}</td>
                    <td className="p-2 tabular-nums">{g.party_size ?? ""}</td>
                    <td className="p-2">{(g.dietary ?? []).join(", ")}</td>
                    <td className="p-2 text-neutral-300">{g.note}</td>
                    <td className="p-2">{g.by_kind ? <span className={g.by_kind === "agent" ? "text-rose-400" : "text-neutral-300"}>{g.by_kind}{g.by_name ? ` · ${g.by_name}` : ""} <span className="text-neutral-500">via {g.channel}</span></span> : <span className="text-neutral-600">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {board.polls.map((p) => {
            const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
            return (
              <section key={p.id} className="rounded-lg border border-neutral-800 p-4 space-y-2">
                <div className="flex justify-between"><h3 className="font-semibold">{p.question}</h3><span className="text-xs text-neutral-500">{total} answered · {p.status}</span></div>
                {p.options.map((o) => (
                  <div key={o} className="flex items-center gap-3 text-sm">
                    <div className="w-28 truncate">{o}</div>
                    <div className="flex-1 h-2 bg-neutral-900 rounded"><div className="h-2 bg-rose-500 rounded" style={{ width: `${total ? (100 * p.counts[o]) / total : 0}%` }} /></div>
                    <div className="w-8 tabular-nums text-right">{p.counts[o]}</div>
                  </div>
                ))}
                <div className="text-xs text-neutral-500">{p.answers.map((a) => `${board.guests.find((g) => g.guest_id === a.guest_id)?.name ?? "?"}: ${a.choice} (${a.by_kind})`).join(" · ")}</div>
              </section>
            );
          })}

          {board.messages.length > 0 && (
            <section className="rounded-lg border border-neutral-800 p-4 space-y-2">
              <h3 className="font-semibold">Messages</h3>
              {board.messages.map((m) => <div key={m.id} className="text-sm"><span className="text-neutral-500">{board.guests.find((g) => g.guest_id === m.guest_id)?.name ?? "host"} ({m.by_kind}, {m.channel}):</span> {m.text}</div>)}
            </section>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            <form action={addGuests} className="grid gap-2 rounded-lg border border-neutral-800 p-4">
              <h3 className="font-semibold">Add guests</h3>
              <textarea name="guests" rows={4} placeholder={"Name, email, max party size\nLeo Chen, leo@example.com, 3\nPriya, priya@example.com\nGrandma, grandma@example.com, 2"} className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm" />
              <div className="flex gap-2"><button className="rounded-md bg-white text-neutral-900 px-4 py-2 font-medium w-fit">Add</button><button type="button" onClick={sendInvites} className="rounded-md border border-neutral-700 px-4 py-2">Email invites to everyone pending</button></div>
            </form>
            <form action={addPoll} className="grid gap-2 rounded-lg border border-neutral-800 p-4">
              <h3 className="font-semibold">Poll the yeses</h3>
              <input name="question" required placeholder="Pizza or tacos?" className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" />
              <input name="options" required placeholder="pizza, tacos" className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" />
              <button className="rounded-md bg-white text-neutral-900 px-4 py-2 font-medium w-fit">Open poll</button>
            </form>
          </div>

          {links.length > 0 && (
            <section className="rounded-lg border border-rose-900/50 p-4 space-y-1">
              <h3 className="font-semibold">Invite links (shown once)</h3>
              {links.map((l) => <div key={l.invite_url} className="text-sm"><span className="text-neutral-400">{l.name}:</span> <a className="underline decoration-rose-500" href={l.invite_url} target="_blank">{l.invite_url}</a></div>)}
            </section>
          )}
        </>
      )}
    </main>
  );
}
