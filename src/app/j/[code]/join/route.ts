import { NextRequest, NextResponse } from "next/server";
import { loadJoin, JoinBody, joinParty } from "@/lib/join";
import { notFound, parseBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const party = await loadJoin(code);
  if (!party) return notFound();
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("form")) {
    const f = await req.formData();
    const b = JoinBody.safeParse({ name: f.get("name"), email: String(f.get("email") ?? ""), by: { kind: "human" } });
    if (!b.success) return NextResponse.json({ error: "invalid", issues: b.error.issues.map((i) => i.message) }, { status: 400 });
    const r = await joinParty(party, b.data);
    if ("error" in r) return NextResponse.json(r, { status: 400 });
    return NextResponse.redirect(r.invite_url!, 303);
  }
  const p = await parseBody(req, JoinBody);
  if ("res" in p) return p.res;
  const r = await joinParty(party, p.data);
  if ("error" in r) return NextResponse.json(r, { status: 400 });
  const { token: _t, ...pub } = r; void _t;
  return NextResponse.json(pub, { status: 201 });
}
