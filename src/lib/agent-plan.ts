import { NextRequest, NextResponse } from "next/server";
import { db } from "./db";
import type { Host } from "./auth";

// Limits for parties created by the agent skill (sold on Agensi). Payment
// happens on Agensi, so these caps are what keep one subscription's cost
// bounded here. Web hosts (signed in) are not affected.
export const AGENT_LIMITS = {
  guests_per_party: 75,
  llm_calls_per_party: 40,
  parties_per_ip_per_day: 10,
  agent_parties_per_hour: 120,
};

export const planLimit = (what: string, limit: number) =>
  NextResponse.json({ error: "plan_limit", detail: `This event reached its plan limit: ${what} (max ${limit}).`, limit }, { status: 402 });

// Routes the agent plan doesn't include (vendors, venues, payments, meet,
// creating more parties through the web route).
export function agentBlocked(host: Host): NextResponse | null {
  return host.scope_party_id
    ? NextResponse.json({ error: "not included", detail: "This route isn't part of the agent event plan. Use the host board or a signed-in account." }, { status: 403 })
    : null;
}

export async function guestCap(host: Host, partyId: string, adding: number): Promise<NextResponse | null> {
  if (!host.scope_party_id) return null;
  const { count } = await db.from("guests").select("id", { count: "exact", head: true }).eq("party_id", partyId);
  const max = AGENT_LIMITS.guests_per_party;
  if ((count ?? 0) + adding > max) return planLimit(`guests (${count ?? 0} already)`, max);
  return null;
}

export async function llmCap(host: Host, partyId: string): Promise<NextResponse | null> {
  if (!host.scope_party_id) return null;
  const { count } = await db.from("llm_calls").select("id", { count: "exact", head: true }).eq("party_id", partyId);
  const max = AGENT_LIMITS.llm_calls_per_party;
  if ((count ?? 0) >= max) return planLimit("planning assistant calls", max);
  return null;
}

export function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim();
}

export async function creationRate(ip: string): Promise<NextResponse | null> {
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const hour = new Date(Date.now() - 3_600_000).toISOString();
  const [{ count: mine }, { count: all }] = await Promise.all([
    db.from("parties").select("id", { count: "exact", head: true }).eq("created_ip", ip).gte("created_at", day),
    db.from("parties").select("id", { count: "exact", head: true }).eq("created_via", "agent").gte("created_at", hour),
  ]);
  if ((mine ?? 0) >= AGENT_LIMITS.parties_per_ip_per_day || (all ?? 0) >= AGENT_LIMITS.agent_parties_per_hour)
    return NextResponse.json({ error: "rate_limited", detail: "Too many new events from here. Try again later." }, { status: 429, headers: { "retry-after": "3600" } });
  return null;
}
