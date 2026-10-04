import { NextRequest, NextResponse } from "next/server";
import { supaServer } from "@/lib/auth";
import { fallback } from "@/lib/fallback";
export async function POST(req: NextRequest) {
  if (!fallback.db) {
    const supa = await supaServer();
    await supa.auth.signOut();
  }
  return NextResponse.redirect(new URL("/host", req.url), 303);
}
