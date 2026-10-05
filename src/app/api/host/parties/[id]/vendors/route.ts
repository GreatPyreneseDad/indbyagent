import { NextRequest, NextResponse } from "next/server";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { parseBody } from "@/lib/http";
import { RequestCreateBody, createRequest, listRequests, listReplies } from "@/lib/vendor-requests";
import { listAuthorizations, listAttempts } from "@/lib/payments";
import { siteUrl } from "@/lib/token";

export const dynamic = "force-dynamic";

// GET: every vendor request for the party, with replies, authorizations and
// payment attempts. POST: create a request (returns the vendor link once).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  try {
    const requests = await listRequests(id, host.id);
    const [replies, auths] = await Promise.all([listReplies(requests.map((r) => r.id)), listAuthorizations(id, host.id)]);
    const attempts = await listAttempts(auths.map((a) => a.id));
    const out = requests.map(({ token_hash: _th, ...r }) => ({
      ...r,
      replies: replies.filter((x) => x.request_id === r.id),
      authorizations: auths.filter((a) => a.request_id === r.id).map((a) => ({ ...a, attempts: attempts.filter((t) => t.authorization_id === a.id) })),
    }));
    return NextResponse.json({ requests: out }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const p = await parseBody(req, RequestCreateBody);
  if ("res" in p) return p.res;
  try {
    const { request, token } = await createRequest(id, host.id, p.data);
    const { token_hash: _th, ...r } = request;
    return NextResponse.json({ request: r, token, request_url: `${siteUrl()}/v/${token}` }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
