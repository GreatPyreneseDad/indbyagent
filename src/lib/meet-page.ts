import { cardText, SCOPES, SCOPE_LABELS, type MeetCard, type MeetContext } from "./meet";
import { siteUrl } from "./token";

const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CSS = `:root{color-scheme:dark;--bg:#0b0a0b;--fg:#f4f2f3;--mut:#9a9396;--line:#2a2527;--rose:#f43f5e;--card:#141214}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:36px 16px 64px;display:grid;gap:18px}.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
h1{margin:0;font-size:clamp(26px,6vw,36px);line-height:1.1;letter-spacing:-.02em}.lead{color:#d9d4d6;margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;display:grid;gap:12px}label{display:grid;gap:5px;font-size:13px;color:var(--mut)}
input,textarea{width:100%;background:#0f0e0f;border:1px solid var(--line);color:var(--fg);padding:12px;border-radius:8px;font:inherit}input.big{font-size:18px;padding:14px}
button{appearance:none;border:1px solid var(--line);background:#1d191b;color:var(--fg);padding:14px 16px;border-radius:8px;font:inherit;font-size:16px;cursor:pointer}button.primary{background:var(--rose);border-color:var(--rose);color:#fff}
.small{font-size:13px;color:var(--mut)}pre{margin:0;overflow-x:auto;background:#0f0e0f;border:1px solid var(--line);border-radius:8px;padding:12px;font:12.5px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--line);font-size:12px;color:var(--mut)}.links a{color:#fda4af;text-decoration:none;margin-right:14px}
.chk{display:flex;gap:10px;align-items:center;color:var(--fg);font-size:15px}.chk input{width:18px;height:18px;margin:0}
details summary{cursor:pointer;color:var(--mut);font-size:13px}`;

export function renderMeetPage(card: MeetCard | null, ctx: MeetContext | null, code: string | null, notice?: string): string {
  if (!card) return shell("Not found", `<div class="wrap"><div class="eyebrow">IndbyAgent</div><h1>This card isn't valid.</h1></div>`);
  const base = `${siteUrl()}/m/${card.slug}`;
  const first = card.display_name.split(" ")[0];
  const body = `
<div class="wrap">
  <div class="eyebrow">IndbyAgent · Meet</div>
  <h1>You just met ${esc(card.display_name)}.</h1>
  ${ctx ? `<div><span class="pill">${esc(ctx.label)}</span></div>` : ""}
  ${card.headline ? `<p class="lead"><b>${esc(card.headline)}</b>${card.blurb ? ` ${esc(card.blurb)}` : ""}</p>` : card.blurb ? `<p class="lead">${esc(card.blurb)}</p>` : ""}
  ${Object.keys(card.links).length ? `<div class="links">${Object.entries(card.links).map(([k, v]) => `<a href="${esc(v)}" rel="noopener">${esc(k)}</a>`).join("")}</div>` : ""}
  ${notice ? `<div class="card" style="border-color:#34d399">${esc(notice)}</div>` : `
  <form class="card" method="post" action="${base}/drop">
    <input type="hidden" name="context" value="${esc(code ?? ctx?.code ?? "")}">
    <strong style="font-size:17px">Drop your agent.</strong>
    <div class="small">An email your agent reads is enough. ${esc(first)}'s agent will write to it with a follow-up, and yours can answer.</div>
    <label>Your agent's address<input class="big" name="agent_address" type="text" inputmode="email" autocomplete="email" required placeholder="you@yourdomain.com or https://…"></label>
    <label>Your name<input name="name" autocomplete="name" placeholder="Optional"></label>
    <label>What we talked about<textarea name="note" rows="2" placeholder="Optional, one line is plenty"></textarea></label>
    <div class="small">${esc(first)}'s agent may:</div>
    ${SCOPES.map((s) => `<label class="chk"><input type="checkbox" name="scopes" value="${s}" ${s === "follow_up" || s === "schedule" ? "checked" : ""}> ${esc(SCOPE_LABELS[s])}</label>`).join("")}
    <button class="primary">Connect our agents</button>
    <div class="small">No account, no app. One email. You can tell the agent to stop any time.</div>
  </form>`}
  <details class="card"><summary>For your agent</summary>
    <div class="small">This page is machine-readable. Point your agent at <code>${esc(base)}.json</code> or paste:</div>
    <pre>${esc(cardText(card, ctx))}</pre>
  </details>
</div>`;
  return shell(`Meet ${card.display_name}`, body);
}

export function renderQrPage(card: MeetCard, ctx: MeetContext | null, url: string, svg: string): string {
  const body = `
<div class="wrap" style="text-align:center;justify-items:center">
  <div class="eyebrow">IndbyAgent · Meet</div>
  <h1>${esc(card.display_name)}</h1>
  ${ctx ? `<div><span class="pill">${esc(ctx.label)}</span></div>` : ""}
  <div style="background:#fff;padding:18px;border-radius:16px;width:min(84vw,360px)">${svg}</div>
  <div class="small">Scan to connect your agent to ${esc(card.display_name.split(" ")[0])}'s.</div>
  <div class="small" style="word-break:break-all">${esc(url)}</div>
</div>`;
  return shell(`QR · ${card.display_name}`, body);
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body>${body}</body></html>`;
}
