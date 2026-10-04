import { NextRequest, NextResponse } from "next/server";
import { hostAuthed, unauthorized, GuestsBody, createGuests } from "@/lib/host";
import { parseBody } from "@/lib/http";

export const dynamic = "force-dynamic";

// Adds guests and returns their invite links (the only time tokens are visible).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hostAuthed(req)) return unauthorized();
  const { id } = await params;
  const p = await parseBody(req, GuestsBody);
  if ("res" in p) return p.res;
  try {
    const guests = await createGuests(id, p.data.guests);
    return NextResponse.json({ guests }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
