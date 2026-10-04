import type { Party } from "./db";
import { fmtWhen } from "./invite";
import { siteUrl } from "./token";

const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
:root{color-scheme:dark;--bg:#0b0a0b;--fg:#f4f2f3;--mut:#9a9396;--line:#2a2527;--rose:#f43f5e;--card:#141214}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:40px 16px 64px;display:grid;gap:20px}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
h1{margin:0;font-size:clamp(28px,7vw,40px);line-height:1.1;letter-spacing:-.02em}
.meta{color:#d9d4d6}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;display:grid;gap:12px}
label{display:grid;gap:5px;font-size:13px;color:var(--mut)}
input{width:100%;background:#0f0e0f;border:1px solid var(--line);color:var(--fg);padding:12px;border-radius:8px;font:inherit;font-size:17px}
button{appearance:none;border:1px solid var(--rose);background:var(--rose);color:#fff;padding:13px 18px;border-radius:8px;font:inherit;font-size:17px;cursor:pointer}
button:focus-visible{outline:2px solid #fff;outline-offset:2px}
pre{margin:0;overflow-x:auto;background:#0f0e0f;border:1px solid var(--line);border-radius:8px;padding:12px;font:12.5px/1.5 ui-monospace,Menlo,monospace}
.small{font-size:13px;color:var(--mut)}
`;

export function renderJoinPage(party: Party | null, code: string): string {
  if (!party) return shell("Not found", `<div class="wrap"><div class="eyebrow">IndbyAgent</div><h1>This join link isn't active.</h1></div>`);
  const base = `${siteUrl()}/j/${code}`;
  const body = `
<div class="wrap">
  <div class="eyebrow">You're invited</div>
  <h1>${esc(party.title)}</h1>
  <div class="meta">${esc(fmtWhen(party))}${party.location ? ` · ${esc(party.location)}` : ""}</div>
  ${party.details ? `<p style="margin:0;color:#d9d4d6">${esc(party.details)}</p>` : ""}
  <form class="card" method="post" action="${base}/join">
    <label>Your name<input name="name" required autocomplete="name" placeholder="Leo Chen"></label>
    <label>Email (optional, so you can reply by email later)<input name="email" type="email" autocomplete="email" placeholder="you@example.com"></label>
    <button>Get my invite</button>
    <div class="small">You'll get a personal link with RSVP, polls, and an agent-readable version.</div>
  </form>
  <section class="card">
    <strong style="font-size:15px">Have an agent? Let it join for you.</strong>
    <pre>curl -s -X POST ${base}/join -H 'content-type: application/json' \\
  -d '{"name":"YOUR NAME","email":"you@example.com","by":{"kind":"agent","name":"YOUR_AGENT"}}'
# returns invite_url. Then: curl -s "$invite_url.json"  and POST .../rsvp</pre>
  </section>
  <div class="small">IndbyAgent · every invite is a link a person can read and an agent can answer.</div>
</div>`;
  return shell(`Join ${party.title}`, body);
}

export function renderScreenPage(party: Party, code: string, joinUrl: string, qrSvg: string): string {
  const stats = `${siteUrl()}/j/${code}.json`;
  const body = `
<style>
.screen{min-height:100vh;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:center;gap:48px;padding:48px;max-width:1400px;margin:0 auto}
.qr{background:#fff;border-radius:24px;padding:28px;width:min(44vw,560px);aspect-ratio:1;display:grid;place-items:center}
.qr svg{width:100%;height:100%}
.big{font-size:clamp(40px,5.5vw,76px);font-weight:800;letter-spacing:-.03em;line-height:1.02;margin:0}
.url{font:600 clamp(18px,2.2vw,30px)/1.2 ui-monospace,Menlo,monospace;color:var(--rose);word-break:break-all;margin-top:10px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:36px}
.stat{border:1px solid var(--line);border-radius:14px;padding:18px}
.stat b{display:block;font-size:clamp(34px,4.5vw,64px);font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1}
.stat span{color:var(--mut);font-size:14px;text-transform:uppercase;letter-spacing:.1em}
.poll{margin-top:26px;border:1px solid var(--line);border-radius:14px;padding:18px;display:none}
.poll h3{margin:0 0 10px;font-size:20px}.bar{display:flex;align-items:center;gap:12px;font-size:18px;margin:6px 0}
.bar .t{flex:1;height:14px;background:#1d191b;border-radius:7px;overflow:hidden}.bar .f{height:100%;background:var(--rose);width:0;transition:width .4s}
.bar .n{width:3ch;text-align:right;font-variant-numeric:tabular-nums}
@media (max-width:900px){.screen{grid-template-columns:1fr;padding:24px}.qr{width:min(80vw,420px)}}
</style>
<div class="screen">
  <div class="qr">${qrSvg}</div>
  <div>
    <div class="eyebrow">Scan to get your invite</div>
    <h1 class="big">${esc(party.title)}</h1>
    <div class="url">${esc(joinUrl.replace(/^https?:\/\//, ""))}</div>
    <div class="stats">
      <div class="stat"><b id="joined">0</b><span>joined</span></div>
      <div class="stat"><b id="yes">0</b><span>coming</span></div>
      <div class="stat"><b id="agent">0</b><span>answered by agent</span></div>
    </div>
    <div class="poll" id="poll"><h3 id="pq"></h3><div id="pb"></div></div>
    <div class="small" style="margin-top:22px">Humans tap. Agents POST. Same link.</div>
  </div>
</div>
<script>
const $=id=>document.getElementById(id);let last={};
async function tick(){try{const r=await fetch(${JSON.stringify(stats)},{cache:'no-store'});const d=await r.json();
for(const k of['joined','yes']){ if(d[k]!==last[k]){$(k).textContent=d[k];}}
if(d.by_agent!==last.by_agent){$('agent').textContent=d.by_agent;}
if(d.poll){$('poll').style.display='block';$('pq').textContent=d.poll.question;const tot=Object.values(d.poll.counts).reduce((a,b)=>a+b,0)||1;
$('pb').innerHTML=Object.entries(d.poll.counts).map(([o,n])=>'<div class="bar"><div style="width:9ch">'+o.replace(/</g,'&lt;')+'</div><div class="t"><div class="f" style="width:'+(100*n/tot)+'%"></div></div><div class="n">'+n+'</div></div>').join('');}
last=d;}catch(e){}}
tick();setInterval(tick,2000);
</script>`;
  return shell(`${party.title} · join`, body);
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body>${body}</body></html>`;
}
