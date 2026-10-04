import { NextRequest, NextResponse } from "next/server";
import { db, type Party } from "@/lib/db";
import { hostAuthed, unauthorized } from "@/lib/host";
import { hashToken, newToken } from "@/lib/token";
import { sendInvites } from "@/lib/mail";

export const dynamic = "force-dynamic";

// Emails every guest with an address who hasn't been invited yet. Tokens are
// rotated at send time so the link in the email is the live one.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hostAuthed(req)) return unauthorized();
  const { id } = await params;
  const { data: party } = await db.from("parties").select("*").eq("id", id).single();
  if (!party) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data: invited } = await db.from("messages").select("guest_id").eq("party_id", id).eq("direction", "out").like("text", "Invite emailed%");
  const done = new Set((invited ?? []).map((m) => m.guest_id));
  const { data: guests } = await db.from("guests").select("id,name,email").eq("party_id", id).not("email", "is", null);
  const todo = (guests ?? []).filter((g) => !done.has(g.id));
  const withTokens = [];
  for (const g of todo) {
    const token = newToken();
    await db.from("guests").update({ token_hash: hashToken(token), token_revoked_at: null }).eq("id", g.id);
    withTokens.push({ ...g, email: g.email as string, token });
  }
  try {
    const r = await sendInvites(party as Party, withTokens);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
