// GET /j/<code>        -> join page (browser) or {party, join action} (agent)
// GET /j/<code>.json   -> stats + how to join (public, minimal; drives the big screen)
import { NextRequest, NextResponse } from "next/server";
import { loadJoin, joinStats } from "@/lib/join";
import { renderJoinPage } from "@/lib/join-page";
import { notFound, wantsJson } from "@/lib/http";
import { siteUrl } from "@/lib/token";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  let { code } = await params;
  let json = wantsJson(req);
  if (code.endsWith(".json")) { code = code.slice(0, -5); json = true; }
  const party = await loadJoin(code);
  if (!party) return json ? notFound() : new NextResponse(renderJoinPage(null, code), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  if (json) {
    const stats = await joinStats(party);
    return NextResponse.json({
      indbyagent: "0.1",
      ...stats,
      actions: { join: `POST ${siteUrl()}/j/${code}/join` },
      schema: { join: { name: "string (required)", email: "string (optional; enables email replies)", by: { kind: "agent|human", name: "string" } } },
      note: "Joining returns your personal invite_url. Use it for everything after this.",
    }, { headers: { "cache-control": "no-store" } });
  }
  return new NextResponse(renderJoinPage(party, code), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
