import { NextRequest, NextResponse } from "next/server";
import { hostAuthed, unauthorized } from "@/lib/host";
import { syncInbox } from "@/lib/inbound";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hostAuthed(req)) return unauthorized();
  const { id } = await params;
  return NextResponse.json(await syncInbox(id));
}
