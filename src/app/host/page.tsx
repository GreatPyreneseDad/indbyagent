"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supaBrowser } from "@/lib/supabase-browser";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = (path: string, init?: RequestInit) => Promise<any>;
type ChatMessage = { id: string; role: "user" | "assistant"; text: string };
type SuggestedPoll = { question: string; options: string[] };
type VenueSuggestion = {
  id: string; status: "pending" | "confirmed" | "rejected"; target_time: string; mock: boolean;
  venue: { name: string; address: string; url: string | null; why: string; capacity_fit: string; est_cost: string | null };
  availability: { status: "open" | "closed" | "unknown"; evidence: string; booking_url: string | null };
  invitees: { available: string[]; unavailable: string[]; unknown: string[] };
  vendors: { category: string; name: string; url: string | null; why: string }[];
  sources: string[];
};

// Mirrors the server's db fallback (lib/fallback.ts): no Supabase locally means
// no sign-in, and the server treats every request as the local test host.
const LOCAL = process.env.NODE_ENV !== "production" && !process.env.NEXT_PUBLIC_SUPABASE_URL;

type Board = {
  party: { id: string; title: string; starts_at: string; timezone: string; location: string | null; inbox_address: string | null };
  summary: { invited: number; yes: number; no: number; maybe: number; needs_human: number; pending: number; headcount: number; by_agent: number; by_human: number };
  guests: { guest_id: string; name: string; email: string | null; status: string | null; party_size: number | null; dietary: string[] | null; note: string | null; by_kind: string | null; by_name: string | null; channel: string | null; answered_at: string | null }[];
  polls: { id: string; question: string; kind: "choice" | "date_rank"; options: string[]; status: string; counts: Record<string, number>; runoff: { winner: string | null; tied: string[]; rounds: Record<string, number>[] } | null; answers: { guest_id: string; choice: string; ranking: string[] | null; by_kind: string; by_name: string | null; channel: string }[] }[];
  messages: { id: string; guest_id: string | null; direction: string; text: string; by_kind: string; by_name: string | null; channel: string; created_at: string }[];
  tokens: { in: number; cached: number; out: number };
};

export default function Host() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [notice, setNotice] = useState("");
  const [me, setMe] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [parties, setParties] = useState<{ id: string; title: string }[]>([]);
  const [partyId, setPartyId] = useState<string>("");
  const [board, setBoard] = useState<Board | null>(null);
  const [links, setLinks] = useState<{ name: string; invite_url: string }[]>([]);
  const [join, setJoin] = useState<{ join_url: string; screen_url: string } | null>(null);
  const [err, setErr] = useState("");
  const [backups, setBackups] = useState<number[]>([]);

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
        if (LOCAL) setMe("local test mode");
        else {
          const { data: { user } } = await supaBrowser().auth.getUser();
          if (!user) return;
          setMe(user.email ?? null);
        }
        const j = await api("/api/host/parties"); setParties(j.parties); setAuthed(true); if (j.parties[0]) setPartyId(j.parties[0].id);
      } catch (e) { setErr((e as Error).message); }
    })();
    const q = new URLSearchParams(window.location.search); if (q.get("error")) setErr(q.get("error")!);
  }, [api]);

  const sendingRef = useRef(false);
  const sendLink = async () => {
    const addr = email.trim().toLowerCase();
    if (!addr || sendingRef.current) return; // one request per click; a double submit races on user creation
    sendingRef.current = true; setErr("");
    try {
      const { error } = await supaBrowser().auth.signInWithOtp({ email: addr, options: { emailRedirectTo: `${window.location.origin}/host` } });
      // A duplicate-user race means the first request already sent the link.
      if (error && !/database error saving new user/i.test(error.message)) setErr(error.message); else setSent(true);
    } finally { sendingRef.current = false; }
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
    const backup_dates = f.getAll("backup_dates").map(String).filter(Boolean).map((d) => new Date(d).toISOString());
    try {
      const j = await api("/api/host/parties", { method: "POST", body: JSON.stringify({ title: f.get("title"), starts_at: starts, backup_dates: backup_dates.length ? backup_dates : undefined, location: f.get("location") || undefined, details: f.get("details") || undefined, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
      setParties((p) => [j.party, ...p]); setPartyId(j.party.id); setBackups([]);
    } catch (e) { setErr((e as Error).message); }
  };
  const addGuests = async (f: FormData) => {
    setErr("");
    const guests = String(f.get("guests")).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      // Tolerant: "Name, email, max" in any order; a bare email works too.
      const parts = l.split(/[,\t;]+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
      const email = parts.find((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
      const max = parts.find((x) => /^\d{1,2}$/.test(x));
      let name = parts.filter((x) => x !== email && x !== max).join(" ").replace(/[<>]/g, "").trim();
      if (!name && email) name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      return { name: name || "Guest", email: email?.toLowerCase(), party_size_max: Number(max) || 1 };
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
    try { const j = await api(`/api/host/parties/${partyId}/invites`, { method: "POST", body: "{}" }); const noEmail = board?.guests.filter((g) => !g.email).length ?? 0; setNotice(`Sent ${j.sent} invite(s) from ${j.from}.` + (j.sent === 0 && noEmail ? ` ${noEmail} guest(s) have no email address — add them again as "Name, email".` : "")); refresh(); }
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
          <input className="w-full rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendLink(); } }} />
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
      {notice && <p className="text-sm text-emerald-400">{notice}</p>}

      {!partyId && (
        <form action={createParty} className="grid gap-3 max-w-lg rounded-lg border border-neutral-800 p-4">
          <h2 className="font-semibold">New party</h2>
          <input name="title" required placeholder="Maya's 6th Birthday" className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2" />
          <label className="grid gap-1 text-xs text-neutral-500">Date
            <input name="starts_at" type="datetime-local" required className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-base text-neutral-100" />
          </label>
          {backups.map((k, i) => (
            <div key={k} className="flex gap-2 items-end">
              <label className="grid gap-1 flex-1 text-xs text-neutral-500">Backup date {i + 1}
                <input name="backup_dates" type="datetime-local" required className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-base text-neutral-100" />
              </label>
              <button type="button" onClick={() => setBackups((b) => b.filter((x) => x !== k))} className="rounded-md border border-neutral-700 px-3 py-2 text-sm">Remove</button>
            </div>
          ))}
          {backups.length < 7 && (
            <button type="button" onClick={() => setBackups((b) => [...b, Date.now()])} className="text-sm text-left text-rose-400 underline w-fit">+ Add a backup date</button>
          )}
          {backups.length > 0 && <p className="text-xs text-neutral-500">Invitees will rank all {backups.length + 1} dates (ranked choice) from their invite link.</p>}
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

          <Planner partyId={board.party.id} api={api} onChange={refresh} />
          <VenueAgent partyId={board.party.id} timezone={board.party.timezone} api={api} />

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
            const isDate = p.kind === "date_rank";
            const label = (o: string) => (isDate ? fmtDate(o, board.party.timezone) : o);
            const r = p.runoff;
            return (
              <section key={p.id} className="rounded-lg border border-neutral-800 p-4 space-y-2">
                <div className="flex justify-between"><h3 className="font-semibold">{p.question}{isDate && <span className="ml-2 text-xs font-normal text-neutral-500">ranked choice · all invitees</span>}</h3><span className="text-xs text-neutral-500">{total} answered · {p.status}</span></div>
                {isDate && total > 0 && r && (
                  <div className="text-sm">
                    {r.winner ? <>Leading after instant runoff: <b className="text-emerald-400">{label(r.winner)}</b>{r.rounds.length > 1 ? ` (${r.rounds.length} rounds)` : ""}</> : r.tied.length ? <>Tied: {r.tied.map(label).join(" · ")}</> : null}
                  </div>
                )}
                {isDate && <div className="text-xs text-neutral-500">Bars show first choices.</div>}
                {p.options.map((o) => (
                  <div key={o} className="flex items-center gap-3 text-sm">
                    <div className={`${isDate ? "w-56" : "w-28"} truncate`}>{label(o)}</div>
                    <div className="flex-1 h-2 bg-neutral-900 rounded"><div className="h-2 bg-rose-500 rounded" style={{ width: `${total ? (100 * p.counts[o]) / total : 0}%` }} /></div>
                    <div className="w-8 tabular-nums text-right">{p.counts[o]}</div>
                  </div>
                ))}
                <div className="text-xs text-neutral-500">{p.answers.map((a) => `${board.guests.find((g) => g.guest_id === a.guest_id)?.name ?? "?"}: ${isDate ? (a.ranking ?? [a.choice]).map(label).join(" › ") : a.choice} (${a.by_kind})`).join(" · ")}</div>
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
              <textarea name="guests" rows={4} placeholder={"One guest per line: Name, email, max party size (a bare email works)\nLeo Chen, leo@example.com, 3\nPriya, priya@example.com\nGrandma, grandma@example.com, 2"} className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm" />
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

function fmtDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

// Chat with Claude about the event. Opening it on a new party starts the
// conversation. Polls Claude suggests are only opened when the host clicks.
function Planner({ partyId, api, onChange }: { partyId: string; api: Api; onChange: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [planning, setPlanning] = useState<Record<string, string>>({});
  const [suggested, setSuggested] = useState<SuggestedPoll[]>([]);
  const [offline, setOffline] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  const apply = (j: { messages: ChatMessage[]; planning: Record<string, string>; suggested_polls?: SuggestedPoll[]; offline?: boolean }) => {
    setMessages(j.messages); setPlanning(j.planning);
    if (j.suggested_polls?.length) setSuggested((s) => [...s, ...j.suggested_polls!]);
    if (j.offline) setOffline(true);
  };

  useEffect(() => {
    let live = true;
    setMessages([]); setPlanning({}); setSuggested([]); setErr(""); setBusy(true);
    api(`/api/host/parties/${partyId}/planner`, { method: "POST", body: "{}" })
      .then((j) => { if (live) apply(j); })
      .catch((e) => { if (live) setErr((e as Error).message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [api, partyId]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages, busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft(""); setErr(""); setBusy(true);
    setMessages((m) => [...m, { id: `pending-${Date.now()}`, role: "user", text }]);
    try { apply(await api(`/api/host/parties/${partyId}/planner`, { method: "POST", body: JSON.stringify({ text }) })); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const openPoll = async (p: SuggestedPoll) => {
    setErr("");
    try {
      await api(`/api/host/parties/${partyId}/polls`, { method: "POST", body: JSON.stringify(p) });
      setSuggested((s) => s.filter((x) => x !== p));
      onChange();
    } catch (e) { setErr((e as Error).message); }
  };

  const notes = Object.entries(planning);
  return (
    <section className="rounded-lg border border-rose-900/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Plan with Claude{offline && <span className="ml-2 text-xs font-normal text-amber-300">scripted (no Claude key)</span>}</h3>
        <button onClick={() => setOpen((o) => !o)} className="text-xs text-neutral-500 underline">{open ? "hide" : "show"}</button>
      </div>
      {open && (
        <div className="grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2 space-y-3">
            <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
              {messages.map((m) => (
                <div key={m.id} className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${m.role === "assistant" ? "bg-neutral-900 text-neutral-200" : "bg-rose-950/40 text-neutral-100 ml-8"}`}>{m.text}</div>
              ))}
              {busy && <div className="text-xs text-neutral-500">Claude is thinking…</div>}
              <div ref={endRef} />
            </div>
            {suggested.map((p) => (
              <div key={p.question} className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-800 px-3 py-2 text-sm">
                <span className="text-neutral-500">Suggested poll:</span> {p.question} <span className="text-neutral-500">({p.options.join(" / ")})</span>
                <button onClick={() => openPoll(p)} className="ml-auto rounded-md bg-white text-neutral-900 px-3 py-1 text-xs font-medium">Open poll</button>
                <button onClick={() => setSuggested((s) => s.filter((x) => x !== p))} className="text-xs text-neutral-500 underline">dismiss</button>
              </div>
            ))}
            <div className="flex gap-2">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} rows={2} placeholder="Answer Claude, or tell it anything about the event…" className="flex-1 rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm" />
              <button onClick={send} disabled={busy || !draft.trim()} className="rounded-md bg-white text-neutral-900 px-4 py-2 font-medium disabled:opacity-50">Send</button>
            </div>
            {err && <p className="text-sm text-red-400">{err}</p>}
          </div>
          <div className="text-sm space-y-1">
            <div className="text-xs uppercase tracking-[.14em] text-neutral-500">Planning notes (not saved to the database)</div>
            {notes.length ? notes.map(([k, v]) => <div key={k}><span className="text-neutral-500">{k.replace(/_/g, " ")}:</span> {v}</div>) : <div className="text-neutral-600">Nothing yet. Answers you give Claude show up here.</div>}
          </div>
        </div>
      )}
    </section>
  );
}

// The venue agent: searches for a venue open at the likely party time, says
// which invitees can make it, and waits for the host to confirm or reject.
function VenueAgent({ partyId, timezone, api }: { partyId: string; timezone: string; api: Api }) {
  const [list, setList] = useState<VenueSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try { setList((await api(`/api/host/parties/${partyId}/venues`)).suggestions); } catch (e) { setErr((e as Error).message); }
  }, [api, partyId]);
  useEffect(() => { setList([]); setNotice(""); setErr(""); load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  const search = async () => {
    setBusy(true); setErr(""); setNotice("");
    try {
      const j = await api(`/api/host/parties/${partyId}/venues`, { method: "POST", body: "{}" });
      setNotice(j.notice?.notified === "email" ? `Suggestion emailed to ${j.notice.to}.` : j.notice?.notified === "console" ? `Notification for ${j.notice.to} printed to the server console (email not configured).` : "");
      await load();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const decide = async (s: VenueSuggestion, decision: "confirm" | "reject") => {
    setErr("");
    try { await api(`/api/host/parties/${partyId}/venues/${s.id}`, { method: "POST", body: JSON.stringify({ decision }) }); await load(); }
    catch (e) { setErr((e as Error).message); }
  };

  const pending = list.filter((s) => s.status === "pending");
  const confirmed = list.find((s) => s.status === "confirmed");
  const decided = list.filter((s) => s.status !== "pending");
  const avail = { open: ["text-emerald-400", "Open then"], closed: ["text-red-400", "Closed then"], unknown: ["text-amber-300", "Hours unknown"] } as const;
  return (
    <section className="rounded-lg border border-neutral-800 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">Venue &amp; vendors</h3>
        {pending.length > 0 && <span className="rounded-full bg-rose-600 px-2 py-0.5 text-xs font-medium text-white">{pending.length} waiting for you</span>}
        {confirmed && <span className="text-sm text-emerald-400">Confirmed: {confirmed.venue.name}</span>}
        <button onClick={search} disabled={busy} className="ml-auto rounded-md bg-white text-neutral-900 px-4 py-2 text-sm font-medium disabled:opacity-50">{busy ? "Searching…" : list.length ? "Find another venue" : "Find a venue"}</button>
      </div>
      {busy && <p className="text-xs text-neutral-500">The agent is searching venues and checking hours for the party time. This can take a minute.</p>}
      {notice && <p className="text-sm text-neutral-400">{notice}</p>}
      {err && <p className="text-sm text-red-400">{err}</p>}
      {pending.map((s) => (
        <div key={s.id} className="rounded-lg border border-rose-900/60 p-4 space-y-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <div className="text-lg font-semibold">{s.venue.url ? <a href={s.venue.url} target="_blank" className="underline decoration-rose-500">{s.venue.name}</a> : s.venue.name}</div>
            <div className="text-sm text-neutral-400">{s.venue.address}</div>
            {s.mock && <span className="text-xs text-amber-300">mock result (no Claude key)</span>}
          </div>
          <div className="text-sm text-neutral-300">{s.venue.why}</div>
          <div className="text-sm text-neutral-400">{s.venue.capacity_fit}{s.venue.est_cost ? ` · ${s.venue.est_cost}` : ""}</div>
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <div className="rounded-md bg-neutral-900 p-3 space-y-1">
              <div className="text-xs uppercase tracking-[.14em] text-neutral-500">{fmtDate(s.target_time, timezone)}</div>
              <div className={avail[s.availability.status][0]}>{avail[s.availability.status][1]}</div>
              <div className="text-neutral-400">{s.availability.evidence}</div>
              <div className="text-xs text-neutral-500">Booking not confirmed. {s.availability.booking_url && <a href={s.availability.booking_url} target="_blank" className="underline">Book or ask</a>}</div>
            </div>
            <div className="rounded-md bg-neutral-900 p-3 space-y-1">
              <div className="text-xs uppercase tracking-[.14em] text-neutral-500">Invitees at that time</div>
              <div><span className="text-emerald-400">Can make it ({s.invitees.available.length}):</span> {s.invitees.available.join(", ") || "—"}</div>
              <div><span className="text-red-400">Can&apos;t ({s.invitees.unavailable.length}):</span> {s.invitees.unavailable.join(", ") || "—"}</div>
              <div><span className="text-neutral-500">Haven&apos;t said ({s.invitees.unknown.length}):</span> {s.invitees.unknown.join(", ") || "—"}</div>
            </div>
          </div>
          {s.vendors.length > 0 && (
            <div className="text-sm space-y-1">
              <div className="text-xs uppercase tracking-[.14em] text-neutral-500">Vendors to consider</div>
              {s.vendors.map((v) => <div key={v.name}><span className="text-neutral-500">{v.category}:</span> {v.url ? <a href={v.url} target="_blank" className="underline">{v.name}</a> : v.name} <span className="text-neutral-400">· {v.why}</span></div>)}
            </div>
          )}
          {s.sources.length > 0 && <div className="text-xs text-neutral-500 truncate">Sources: {s.sources.map((u) => <a key={u} href={u} target="_blank" className="underline mr-2">{u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</a>)}</div>}
          <div className="flex gap-2">
            <button onClick={() => decide(s, "confirm")} className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-sm font-medium">Confirm venue</button>
            <button onClick={() => decide(s, "reject")} className="rounded-md border border-neutral-700 px-4 py-2 text-sm">Reject</button>
          </div>
        </div>
      ))}
      {decided.length > 0 && (
        <div className="text-xs text-neutral-500">{decided.map((s) => `${s.venue.name}: ${s.status}`).join(" · ")}</div>
      )}
      {!list.length && !busy && <p className="text-sm text-neutral-500">The agent will suggest a venue open at the party time (the leading date if guests are ranking dates) and show which invitees can make it.</p>}
    </section>
  );
}
