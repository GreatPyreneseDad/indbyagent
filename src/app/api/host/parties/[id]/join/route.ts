import { NextRequest, NextResponse } from "next/server";
import { db, type Party } from "@/lib/db";
import { hostAuthed, unauthorized } from "@/lib/host";
import { ensureJoinCode, joinUrl, screenUrl } from "@/lib/join";

export const dynamic = "force-dynamic";

// Creates (or rotates) the party's public join code. Returns the join URL and
// the big-screen URL. The code is shown once; it's hashed at rest.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hostAuthed(req)) return unauthorized();
  const { id } = await params;
  const { data: party } = await db.from("parties").select("*").eq("id", id).single();
  if (!party) return NextResponse.json({ error: "not found" }, { status: 404 });
  const code = await ensureJoinCode(party as Party);
  return NextResponse.json({ join_url: joinUrl(code), screen_url: screenUrl(code) });
}
