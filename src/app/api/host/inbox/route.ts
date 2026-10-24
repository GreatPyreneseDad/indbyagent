import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { currentHost } from "@/lib/auth";
import { unauthorized } from "@/lib/host";
import { parseBody } from "@/lib/http";
import { accountForHost, linkHostByToken, startOwnInbox, verifyOwnInbox } from "@/lib/own-inbox";

export const dynamic = "force-dynamic";

// "Use your own inbox" for a host (works with a signed-in host or an agent's
// iba_ host token).
//   GET                         -> status
//   POST { email?, username? }  -> AgentMail signs the host up; a 6-digit code goes to their email
//   POST { otp }                -> verifies; returns an inbox_token (shown once)
//   POST { inbox_token }        -> lets this host (e.g. an agent's next event) use that inbox
const Body = z.object({
  email: z.string().email().optional(),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,40}$/).optional(),
  otp: z.string().trim().regex(/^\d{6}$/).optional(),
  inbox_token: z.string().trim().startsWith("ibx_").optional(),
});

const NOTE = "Your own AgentMail account, in your name. New accounts are ramped by AgentMail (a few recipients on day one, 10 in the first week); anything over the limit is sent from an IndbyAgent inbox instead, and replies still reach your event. You can claim the account at console.agentmail.to with this email.";

export async function GET(req: NextRequest) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const a = await accountForHost(host);
  return NextResponse.json({ email: host.email, inbox: a?.inbox_id ?? null, status: a?.status ?? "none", note: NOTE });
}

export async function POST(req: NextRequest) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const p = await parseBody(req, Body);
  if ("res" in p) return p.res;
  if (p.data.inbox_token) {
    const r = await linkHostByToken(host.id, p.data.inbox_token);
    return r ? NextResponse.json(r) : NextResponse.json({ error: "unknown inbox token" }, { status: 400 });
  }
  let email = host.email;
  if (!email && p.data.email) {
    await db.from("hosts").update({ email: p.data.email }).eq("id", host.id);
    email = p.data.email;
  }
  if (!email) return NextResponse.json({ error: "the host needs an email: send { email }" }, { status: 400 });
  try {
    if (p.data.otp) {
      const r = await verifyOwnInbox(email, p.data.otp, host.id);
      if ("error" in r) return NextResponse.json(r, { status: 400 });
      return NextResponse.json({ ...r, inbox_token_note: "Shown once. Keep it: send { inbox_token } from your next event's host token to send from this inbox again.", note: "Verified. Events that have not sent invites yet will send from this inbox." }, { headers: { "cache-control": "no-store" } });
    }
    const username = p.data.username ?? (host.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "host") + "-events";
    const r = await startOwnInbox(email, username);
    if ("error" in r) return NextResponse.json(r, { status: 409 });
    return NextResponse.json({ ...r, next: `AgentMail emailed a 6-digit code to ${email}. POST { "otp": "123456" } to this URL to finish.`, note: NOTE }, { status: 201 });
  } catch (e) {
    const x = e as { statusCode?: number; body?: unknown; message?: string };
    return NextResponse.json({ error: "AgentMail refused", status: x.statusCode ?? null, detail: x.body ?? x.message }, { status: 502 });
  }
}
