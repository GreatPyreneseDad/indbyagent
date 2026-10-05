import { NextRequest, NextResponse } from "next/server";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { parseBody, idem } from "@/lib/http";
import { getRequest } from "@/lib/vendor-requests";
import { AuthorizeBody, ExecuteBody, authorize, execute, listAuthorizations } from "@/lib/payments";

export const dynamic = "force-dynamic";

// POST {max_amount, currency?, provider?, payment_method_ref?, purpose?, expires_in_hours?}
// The HOST authorizes a bounded payment envelope for this accepted vendor.
// Bearer HOST_SECRET counts as the host for scripts; an agent acting for the
// host uses the same credential the host gave it. Nothing is charged here.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id, rid } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const r = await getRequest(id, host.id, rid);
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  const p = await parseBody(req, AuthorizeBody.omit({ request_id: true }));
  if ("res" in p) return p.res;
  const a = await authorize(id, host.id, r, { ...p.data, request_id: rid });
  if ("error" in a) return NextResponse.json(a, { status: 409 });
  return NextResponse.json({ authorization: a, execute: `POST /api/host/parties/${id}/vendors/${rid}/payments/${a.id}` }, { status: 201 });
}

// PUT {amount, currency?, note?, by?} on the newest live authorization: execute
// inside the envelope. Refusals are recorded, not thrown.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id, rid } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const r = await getRequest(id, host.id, rid);
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  const a = (await listAuthorizations(id, host.id)).find((x) => x.request_id === rid && !x.revoked_at);
  if (!a) return NextResponse.json({ error: "no live authorization for this request; the host must authorize first" }, { status: 409 });
  const p = await parseBody(req, ExecuteBody);
  if ("res" in p) return p.res;
  const t = await execute(a, r, p.data, { idempotency_key: idem(req), defaultKind: "agent" });
  return NextResponse.json({ attempt: t }, { status: t.status === "refused" ? 403 : 200 });
}
