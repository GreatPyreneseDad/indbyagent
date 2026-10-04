import { NextRequest, NextResponse } from "next/server";
import { supaServer } from "@/lib/auth";
export async function POST(req: NextRequest) {
  const supa = await supaServer();
  await supa.auth.signOut();
  return NextResponse.redirect(new URL("/host", req.url), 303);
}
