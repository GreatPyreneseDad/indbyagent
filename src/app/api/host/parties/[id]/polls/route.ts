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
  const row = { party_id: id, ...p.data, question: p.data.question ?? "Which dates work for you?" };
  if (row.kind === "dates") row.options = row.options.map((o) => new Date(o).toISOString());
  const { data, error } = await db.from("polls").insert(row).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ poll: data }, { status: 201 });
}
