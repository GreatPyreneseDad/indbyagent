import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { areaKey, norm } from "./engine/match";

// Typical drive minutes between neighborhood pairs, estimated once by Claude and
// cached per region for every builder. Areas are neighborhoods, never addresses.
const MODEL = "claude-sonnet-5-5";

export async function areaMinutes(region: string, pairs: [string, string][], opts: { estimate: boolean; budget: number }) {
  const reg = norm(region || "unknown");
  const want = [...new Map(pairs.filter(([a, b]) => norm(a) !== norm(b)).map(([a, b]) => [areaKey(a, b), [a, b] as [string, string]])).entries()];
  const out = new Map<string, number>();
  if (!want.length) return { minutes: out, estimated: 0, warning: null as string | null };
  for (let i = 0; i < want.length; i += 200) {
    const { data } = await db.from("area_minutes").select("pair, minutes").eq("region", reg).in("pair", want.slice(i, i + 200).map(([k]) => k));
    for (const r of data ?? []) out.set(r.pair as string, r.minutes as number);
  }
  let missing = want.filter(([k]) => !out.has(k));
  if (!opts.estimate || !missing.length) return { minutes: out, estimated: 0, warning: null };
  if (!process.env.ANTHROPIC_API_KEY) return { minutes: out, estimated: 0, warning: "area_estimate_unavailable" };
  const capped = missing.length > Math.min(120, opts.budget);
  missing = missing.slice(0, Math.min(120, opts.budget));
  if (!missing.length) return { minutes: out, estimated: 0, warning: "area_estimate_daily_limit" };

  const msg = await new Anthropic().messages.create({
    model: MODEL, max_tokens: 2000,
    system: "You estimate typical off-peak driving time in whole minutes between two neighborhoods or towns in a given region, for carpool pickup planning. Reply with JSON only: an array of integers, one per numbered pair, in order. Use your best estimate; never refuse.",
    messages: [{ role: "user", content: `Region: ${region}\n\n${missing.map(([, [a, b]], i) => `${i + 1}. ${a} -> ${b}`).join("\n")}` }],
  }).catch((e) => { console.error("[builder/areas]", e instanceof Error ? e.message : e); return null; });
  if (!msg) return { minutes: out, estimated: 0, warning: "area_estimate_unavailable" };
  const text = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  let nums: unknown;
  try { nums = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)); } catch { nums = null; }
  if (!Array.isArray(nums)) return { minutes: out, estimated: 0, warning: "area_estimate_unavailable" };
  const rows = missing.flatMap(([k], i) => {
    const m = Number((nums as unknown[])[i]);
    return Number.isFinite(m) && m >= 0 && m < 1000 ? [{ region: reg, pair: k, minutes: Math.round(m), source: "ai" }] : [];
  });
  for (const r of rows) out.set(r.pair, r.minutes);
  if (rows.length) await db.from("area_minutes").upsert(rows, { onConflict: "region,pair" });
  return { minutes: out, estimated: rows.length, warning: capped ? "area_estimate_partial" : null };
}
