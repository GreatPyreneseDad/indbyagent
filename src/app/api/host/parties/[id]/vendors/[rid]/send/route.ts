import { NextRequest, NextResponse } from "next/server";
import { db, type Party } from "@/lib/db";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { getRequest, markSent, rotateToken } from "@/lib/vendor-requests";
import { sendVendorRequest } from "@/lib/mail";
import { siteUrl } from "@/lib/token";

export const dynamic = "force-dynamic";

// POST: (re)issue the link and, when the vendor has an email, send it from the
// party inbox. Templated, zero model tokens. Without an email the host gets the
// link back to deliver however they like.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id, rid } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const r = await getRequest(id, host.id, rid);
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (["accepted", "closed"].includes(r.status)) return NextResponse.json({ error: `request is ${r.status}` }, { status: 409 });
  const { data: party } = await db.from("parties").select("*").eq("id", id).single();
  if (!party) return NextResponse.json({ error: "party not found" }, { status: 404 });
  const token = await rotateToken(r.id);
  const url = `${siteUrl()}/v/${token}`;
  if (r.vendor.email) {
    try {
      const sent = await sendVendorRequest(party as Party, r, url);
      await markSent(r.id, "email");
      return NextResponse.json({ sent: "email", to: r.vendor.email, from: sent.from, request_url: url });
    } catch (e) {
      return NextResponse.json({ sent: "link", request_url: url, warning: `email failed: ${(e as Error).message}` }, { status: 207 });
    }
  }
  await markSent(r.id, "link");
  return NextResponse.json({ sent: "link", request_url: url, note: "no vendor email on file; share the link yourself" });
}
