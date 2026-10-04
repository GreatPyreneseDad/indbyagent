import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { unauthorized, forbidden, PollCreateBody } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { parseBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const p = await parseBody(req, PollCreateBody);
  if ("res" in p) return p.res;
  const { data, error } = await db.from("polls").insert({ party_id: id, ...p.data }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ poll: data }, { status: 201 });
}
