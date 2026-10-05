import { NextRequest, NextResponse } from "next/server";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { parseBody } from "@/lib/http";
import { RequestPatchBody, patchRequest } from "@/lib/vendor-requests";

export const dynamic = "force-dynamic";

// PATCH {status:"accepted"|"closed", revoke_link?:true}. Accepting is the host
// saying "we want you"; it sends nothing and pays nothing by itself.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id, rid } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const p = await parseBody(req, RequestPatchBody);
  if ("res" in p) return p.res;
  const r = await patchRequest(id, host.id, rid, p.data);
  if ("error" in r) return NextResponse.json(r, { status: r.error === "not found" ? 404 : 409 });
  const { token_hash: _th, ...out } = r;
  return NextResponse.json({ request: out });
}
