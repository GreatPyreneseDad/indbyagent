import { NextRequest, NextResponse } from "next/server";
import { unauthorized, forbidden, GuestsBody, createGuests } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { parseBody } from "@/lib/http";

export const dynamic = "force-dynamic";

// Adds guests and returns their invite links (the only time tokens are visible).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const p = await parseBody(req, GuestsBody);
  if ("res" in p) return p.res;
  try {
    const guests = await createGuests(id, p.data.guests);
    return NextResponse.json({ guests }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
