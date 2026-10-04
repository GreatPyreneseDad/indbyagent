import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { unauthorized, PartyBody, slugify, dateOptions, DATE_POLL_QUESTION } from "@/lib/host";
import { currentHost } from "@/lib/auth";
import { parseBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { data } = await db.from("parties").select("id,slug,title,starts_at,location,inbox_address,created_at").eq("host_id", host.id).order("created_at", { ascending: false });
  return NextResponse.json({ parties: data ?? [] });
}

export async function POST(req: NextRequest) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const p = await parseBody(req, PartyBody);
  if ("res" in p) return p.res;
  const { backup_dates, ...fields } = p.data;
  const { data, error } = await db.from("parties").insert({ ...fields, host_id: host.id, slug: slugify(fields.title) }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  // Backup dates (or no date at all) open a ranked "dates" poll for every invitee.
  const options = dateOptions([...(fields.starts_at ? [fields.starts_at] : []), ...(backup_dates ?? [])]);
  let date_poll = null;
  if (options.length > 1 || (!fields.starts_at && options.length === 1)) {
    const { data: poll } = await db.from("polls").insert({ party_id: data.id, kind: "dates", question: DATE_POLL_QUESTION, options }).select().single();
    date_poll = poll;
  }
  return NextResponse.json({ party: data, date_poll }, { status: 201 });
}
