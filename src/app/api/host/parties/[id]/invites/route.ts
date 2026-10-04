import { NextRequest, NextResponse } from "next/server";
import { db, type Party } from "@/lib/db";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { hashToken, newToken } from "@/lib/token";
import { sendInvites, ensureInbox } from "@/lib/mail";

export const dynamic = "force-dynamic";

// Emails every guest with an address who hasn't been invited yet. Tokens are
// rotated at send time so the link in the email is the live one.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const { data: party } = await db.from("parties").select("*").eq("id", id).single();
  if (!party) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data: invited } = await db.from("messages").select("guest_id").eq("party_id", id).eq("direction", "out").like("text", "Invite emailed%");
  const done = new Set((invited ?? []).map((m) => m.guest_id));
  const { data: guests } = await db.from("guests").select("id,name,email").eq("party_id", id).not("email", "is", null);
  const todo = (guests ?? []).filter((g) => !done.has(g.id));
  try {
    // Make sure we can send at all before touching any token: a rotated token
    // with no email behind it is a dead link.
    const from = await ensureInbox(party as Party);
    let sent = 0;
    for (const g of todo) {
      const { data: prev } = await db.from("guests").select("token_hash").eq("id", g.id).single();
      const token = newToken();
      await db.from("guests").update({ token_hash: hashToken(token), token_revoked_at: null }).eq("id", g.id);
      try {
        await sendInvites(party as Party, [{ ...g, email: g.email as string, token }]);
        sent++;
      } catch (e) {
        if (prev) await db.from("guests").update({ token_hash: prev.token_hash }).eq("id", g.id); // keep the old link alive
        throw e;
      }
    }
    return NextResponse.json({ from, sent });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
