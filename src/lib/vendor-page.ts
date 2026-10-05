import { requestText, type RequestCtx } from "./vendor-requests";
import { fmtDate } from "./invite";
import { siteUrl } from "./token";

const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CSS = `:root{color-scheme:dark;--bg:#0b0a0b;--fg:#f4f2f3;--mut:#9a9396;--line:#2a2527;--rose:#f43f5e;--card:#141214}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:620px;margin:0 auto;padding:40px 16px 64px;display:grid;gap:20px}.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
h1{margin:0;font-size:clamp(26px,6vw,36px);line-height:1.1;letter-spacing:-.02em}.meta{color:#d9d4d6;display:grid;gap:4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;display:grid;gap:12px}label{display:grid;gap:5px;font-size:13px;color:var(--mut)}
input,select,textarea{width:100%;background:#0f0e0f;border:1px solid var(--line);color:var(--fg);padding:11px;border-radius:8px;font:inherit}
button{appearance:none;border:1px solid var(--line);background:#1d191b;color:var(--fg);padding:12px 16px;border-radius:8px;font:inherit;cursor:pointer}button.primary{background:var(--rose);border-color:var(--rose);color:#fff}
.row{display:flex;gap:10px;flex-wrap:wrap}.small{font-size:13px;color:var(--mut)}pre{margin:0;overflow-x:auto;background:#0f0e0f;border:1px solid var(--line);border-radius:8px;padding:12px;font:12.5px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--line);font-size:12px;color:var(--mut)}`;

export function renderVendorPage(ctx: RequestCtx | null, token: string, notice?: string): string {
  if (!ctx) return shell("Request not found", `<div class="wrap"><div class="eyebrow">IndbyAgent</div><h1>This request link isn't valid.</h1><p class="small">It may have been withdrawn. Ask the host for a fresh link.</p></div>`);
  const { request: r, party, replies } = ctx;
  const b = `${siteUrl()}/v/${token}`;
  const when = party.starts_at ? fmtDate(party.starts_at, party.timezone) : "Date TBD";
  const latest = replies[0];
  const closed = r.status === "accepted" || r.status === "closed";
  const body = `
<div class="wrap">
  <div class="eyebrow">Request for quote · ${esc(r.vendor.category)}</div>
  <h1>${esc(r.vendor.name)}, a host is asking for a quote.</h1>
  <div class="meta">
    <div><b>Party</b> ${esc(party.title)} · ${esc(when)}${party.location ? ` · ${esc(party.location)}` : ""}</div>
    <div><b>Need</b> ${esc(r.need)}</div>
    ${r.budget_line ? `<div><b>Budget line</b> ${esc(r.budget_line)}</div>` : ""}
    ${r.needed_by ? `<div><b>Needed by</b> ${esc(r.needed_by)}</div>` : ""}
    <div><span class="pill">${esc(r.status)}</span></div>
  </div>
  ${notice ? `<div class="card" style="border-color:#34d399">${esc(notice)}</div>` : ""}
  ${latest ? `<div class="card"><div class="small">Your latest reply (${esc(latest.kind)}${latest.by_kind === "agent" ? ", by your agent" : ""})</div><div>${latest.price != null ? `<b>${latest.price.toFixed(2)} ${esc(latest.currency.toUpperCase())}</b> · ` : ""}${esc(latest.available ?? "")}${latest.notes ? ` · ${esc(latest.notes)}` : ""}</div></div>` : ""}
  ${closed ? `<div class="card">This request is ${esc(r.status)}. The host is no longer collecting quotes here.</div>` : `
  <form class="card" method="post" action="${b}/quote">
    <strong>Send a quote</strong>
    <div class="row"><label style="flex:1">Price<input name="price" type="number" step="0.01" min="0" required placeholder="120.00"></label><label style="width:7em">Currency<input name="currency" value="usd" maxlength="3"></label></div>
    <label>Availability<select name="available"><option value="yes">Yes, we can do this</option><option value="alternative">Only at another time</option><option value="no">Not available</option></select></label>
    <label>Lead time (days)<input name="lead_time_days" type="number" min="0" max="365" placeholder="3"></label>
    <label>Notes<textarea name="notes" rows="3" placeholder="Nut-free is fine. Pickup after 9am."></textarea></label>
    <div class="row"><button class="primary">Send quote</button></div>
  </form>
  <form class="card" method="post" action="${b}/decline"><strong>Can't do it?</strong><label>Reason (optional)<input name="reason" placeholder="Booked that day"></label><div class="row"><button>Decline</button></div></form>
  <form class="card" method="post" action="${b}/message"><strong>Ask the host</strong><label>Message<textarea name="text" rows="2" required placeholder="How many servings?"></textarea></label><div class="row"><button>Send</button></div></form>`}
  <section class="card">
    <strong style="font-size:15px">For your agent</strong>
    <div class="small">This request is machine-readable. Give your agent the link, or paste this:</div>
    <pre>${esc(requestText(ctx, token))}</pre>
  </section>
  <div class="small">A quote is not a booking. The host confirms in writing before anything is reserved or paid. IndbyAgent never takes payment on your behalf.</div>
</div>`;
  return shell(`Quote request · ${r.vendor.name}`, body);
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body>${body}</body></html>`;
}
