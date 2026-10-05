import { NextRequest, NextResponse } from "next/server";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { parseBody, idem } from "@/lib/http";
import { getRequest } from "@/lib/vendor-requests";
import { ExecuteBody, execute, listAuthorizations, listAttempts, revoke } from "@/lib/payments";

export const dynamic = "force-dynamic";

async function gate(req: NextRequest, params: Promise<{ id: string; rid: string; aid: string }>) {
  const host = await currentHost(req);
  if (!host) return { res: unauthorized() };
  const { id, rid, aid } = await params;
  if (!(await hostOwnsParty(host, id))) return { res: forbidden() };
  const r = await getRequest(id, host.id, rid);
  if (!r) return { res: NextResponse.json({ error: "not found" }, { status: 404 }) };
  const a = (await listAuthorizations(id, host.id)).find((x) => x.id === aid && x.request_id === rid);
  if (!a) return { res: NextResponse.json({ error: "authorization not found" }, { status: 404 }) };
  return { host, id, rid, r, a };
}

// GET: the authorization and its attempts (the audit trail).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string; aid: string }> }) {
  const g = await gate(req, params); if ("res" in g) return g.res;
  return NextResponse.json({ authorization: g.a, attempts: await listAttempts([g.a.id]) }, { headers: { "cache-control": "no-store" } });
}

// POST {amount, currency?, note?, by?}: execute a payment inside this envelope.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string; aid: string }> }) {
  const g = await gate(req, params); if ("res" in g) return g.res;
  const p = await parseBody(req, ExecuteBody);
  if ("res" in p) return p.res;
  const t = await execute(g.a, g.r, p.data, { idempotency_key: idem(req), defaultKind: "agent" });
  return NextResponse.json({ attempt: t }, { status: t.status === "refused" ? 403 : 200 });
}

// DELETE: the host revokes the envelope. Nothing further can be executed.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string; aid: string }> }) {
  const g = await gate(req, params); if ("res" in g) return g.res;
  const a = await revoke(g.id, g.host.id, g.a.id);
  if ("error" in a) return NextResponse.json(a, { status: 404 });
  return NextResponse.json({ authorization: a });
}
