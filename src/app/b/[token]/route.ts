// GET /b/<board_token> — the host's read-only board for an agent-created event.
// Holds no write power: the host token stays with the host's agent.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loadBoard } from "@/lib/board";
import { hashToken, looksLikeToken } from "@/lib/token";

export const dynamic = "force-dynamic";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const html = (body: string, status = 200) => new NextResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Event board · IndbyAgent</title><style>
:root{color-scheme:dark;--bg:#0b0a0b;--fg:#f4f2f3;--mut:#9a9396;--line:#2a2527;--rose:#f43f5e;--card:#141214}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:32px 16px 64px;display:grid;gap:18px}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}h1{margin:0;font-size:clamp(26px,6vw,36px);line-height:1.1}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;overflow-x:auto}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}.stat b{display:block;font-size:26px}.stat span{color:var(--mut);font-size:13px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}th{color:var(--mut);font-weight:500}
.mut{color:var(--mut);font-size:13px}.yes{color:#4ade80}.no{color:#f87171}.maybe{color:#fbbf24}.needs_human{color:var(--rose)}
</style></head><body><div class="wrap">${body}</div></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const missing = () => html(`<div class="eyebrow">IndbyAgent</div><h1>This board link isn't active.</h1>`, 404);
  if (!looksLikeToken(token)) return missing();
  const { data: p } = await db.from("parties").select("id").eq("board_token_hash", hashToken(token)).maybeSingle();
  if (!p) return missing();
  const b = await loadBoard(p.id as string);
  if (!b) return missing();
  const party = b.party as Record<string, string | null>;
  if (new URL(req.url).searchParams.get("format") === "json") {
    const { messages: _m, tokens: _t, ...rest } = b;
    return NextResponse.json(rest, { headers: { "cache-control": "no-store" } });
  }
  const when = party.starts_at ? new Date(party.starts_at).toLocaleString("en-US", { timeZone: party.timezone ?? "UTC", dateStyle: "full", timeStyle: "short" }) : "Date TBD";
  const s = b.summary;
  const stat = (n: number, l: string) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`;
  const guests = b.guests.map((g) => `<tr><td>${esc(g.name)}</td><td class="${esc(g.status ?? "pending")}">${esc(g.status ?? "pending")}</td><td>${g.status === "yes" ? esc(g.party_size ?? 1) : ""}</td><td>${esc((g.dietary ?? []).join(", "))}</td><td class="mut">${esc(g.by_kind ? `${g.by_kind}${g.by_name ? ` (${g.by_name})` : ""}` : "")}</td></tr>`).join("");
  const polls = b.polls.map((pl) => {
    const order: string[] = pl.ranked?.ranked ?? pl.options;
    const label = (o: string) => pl.kind === "dates" ? new Date(o).toLocaleString("en-US", { timeZone: party.timezone ?? "UTC", dateStyle: "medium", timeStyle: "short" }) : o;
    const rows = order.map((o) => `<tr><td>${esc(label(o))}</td><td>${pl.kind === "dates" ? `${pl.ranked?.score[o] ?? 0} pts` : `${pl.counts[o] ?? 0}`}</td></tr>`).join("");
    return `<div class="card"><div class="eyebrow">${pl.kind === "dates" ? "Date poll" : "Poll"} · ${esc(pl.status)}</div><p><b>${esc(pl.question)}</b> <span class="mut">${pl.answers.length} answered</span></p><table>${rows}</table></div>`;
  }).join("");
  const msgs = b.messages.filter((m) => m.direction === "in").slice(0, 15).map((m) => `<tr><td class="mut">${esc(new Date(m.created_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }))}</td><td>${esc(m.by_name ?? "")}</td><td>${esc(m.text)}</td></tr>`).join("");
  return html(`
<div class="eyebrow">Event board · read-only</div>
<h1>${esc(party.title)}</h1>
<div>${esc(when)}${party.location ? ` · ${esc(party.location)}` : ""}</div>
<div class="card stats">${stat(s.invited, "invited")}${stat(s.yes, "yes")}${stat(s.headcount, "headcount")}${stat(s.maybe, "maybe")}${stat(s.no, "no")}${stat(s.pending, "waiting")}${s.needs_human ? stat(s.needs_human, "need you") : ""}</div>
${polls}
<div class="card"><div class="eyebrow">Guests</div><table><tr><th>Name</th><th>RSVP</th><th>Size</th><th>Dietary</th><th>Answered by</th></tr>${guests || `<tr><td colspan="5" class="mut">No guests yet.</td></tr>`}</table></div>
${msgs ? `<div class="card"><div class="eyebrow">Messages from guests</div><table>${msgs}</table></div>` : ""}
<div class="mut">Your agent manages this event. Ask it to add guests, send invites, run a poll or lock the date. This page only shows the board.</div>`);
}
