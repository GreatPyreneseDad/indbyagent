import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { PartyBody, slugify, dateOptions, DATE_POLL_QUESTION } from "@/lib/host";
import { HOST_TOKEN_PREFIX } from "@/lib/auth";
import { parseBody } from "@/lib/http";
import { hashToken, newToken, siteUrl } from "@/lib/token";
import { AGENT_LIMITS, clientIp, creationRate } from "@/lib/agent-plan";

export const dynamic = "force-dynamic";

const AgentPartyBody = PartyBody.and(z.object({
  host: z.object({
    name: z.string().trim().min(1).max(80),
    email: z.string().email().optional(),
  }),
}));

// POST /api/agent/parties — the agent skill's front door. No account: creates
// a host and a party, returns a host token scoped to this one party (shown
// once, stored hashed) and a read-only board link for the host's browser.
export async function POST(req: NextRequest) {
  const p = await parseBody(req, AgentPartyBody);
  if ("res" in p) return p.res;
  const ip = clientIp(req);
  const limited = await creationRate(ip);
  if (limited) return limited;

  const { host, backup_dates, ...fields } = p.data;
  const { data: h, error: he } = await db.from("hosts").insert({ name: host.name, email: host.email ?? null }).select().single();
  if (he || !h) return NextResponse.json({ error: he?.message ?? "could not create host" }, { status: 500 });

  const hostToken = HOST_TOKEN_PREFIX + newToken();
  const boardToken = newToken();
  const { data: party, error } = await db.from("parties").insert({
    ...fields, host_id: h.id, slug: slugify(fields.title),
    host_token_hash: hashToken(hostToken), board_token_hash: hashToken(boardToken),
    created_via: "agent", created_ip: ip, join_max: AGENT_LIMITS.guests_per_party,
  }).select("id,slug,title,kind,starts_at,ends_at,timezone,location,details,rsvp_by").single();
  if (error || !party) {
    await db.from("hosts").delete().eq("id", h.id);
    return NextResponse.json({ error: error?.message ?? "could not create event" }, { status: 400 });
  }

  const options = dateOptions([...(fields.starts_at ? [fields.starts_at] : []), ...(backup_dates ?? [])]);
  let date_poll = null;
  if (options.length > 1 || (!fields.starts_at && options.length === 1)) {
    const { data: poll } = await db.from("polls").insert({ party_id: party.id, kind: "dates", question: DATE_POLL_QUESTION, options }).select().single();
    date_poll = poll;
  }

  const api = `${siteUrl()}/api/host/parties/${party.id}`;
  return NextResponse.json({
    party_id: party.id,
    party,
    host_token: hostToken,
    host_token_note: "Shown once. Send as 'Authorization: Bearer <host_token>'. It controls only this event. Never share it.",
    board_url: `${siteUrl()}/b/${boardToken}`,
    date_poll,
    api,
    limits: { guests: AGENT_LIMITS.guests_per_party, planner_calls: AGENT_LIMITS.llm_calls_per_party },
    next: [`POST ${api}/guests`, `POST ${api}/invites`, `GET ${api}/board`],
  }, { status: 201, headers: { "cache-control": "no-store" } });
}
