import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hostAuthed, unauthorized, PartyBody, defaultHost, slugify } from "@/lib/host";
import { parseBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!hostAuthed(req)) return unauthorized();
  const { data } = await db.from("parties").select("id,slug,title,starts_at,location,inbox_address,created_at").order("created_at", { ascending: false });
  return NextResponse.json({ parties: data ?? [] });
}

export async function POST(req: NextRequest) {
  if (!hostAuthed(req)) return unauthorized();
  const p = await parseBody(req, PartyBody);
  if ("res" in p) return p.res;
  const host = await defaultHost();
  const { data, error } = await db.from("parties").insert({ ...p.data, host_id: host.id, slug: slugify(p.data.title) }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ party: data }, { status: 201 });
}
