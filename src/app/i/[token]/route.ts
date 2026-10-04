// GET /i/<token>            -> HTML (browser) or JSON (Accept: application/json)
// GET /i/<token>.json|.txt|.ics
// GET never changes anything: link previews and mail scanners prefetch these URLs.
import { NextRequest, NextResponse } from "next/server";
import { loadInvite, inviteJson, inviteText, inviteIcs } from "@/lib/invite";
import { renderInvitePage } from "@/lib/invite-page";
import { notFound, wantsJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  let { token } = await params;
  type Fmt = "html" | "json" | "txt" | "ics";
  let fmt: Fmt = wantsJson(req) ? "json" : "html";
  const m = token.match(/^(.*)\.(json|txt|ics)$/);
  if (m) { token = m[1]; fmt = m[2] as Fmt; }
  const ctx = await loadInvite(token);
  if (!ctx) return fmt === "html" ? new NextResponse(renderInvitePage(null, token), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }) : notFound();

  const cache = { "cache-control": "private, max-age=30", vary: "accept" };
  if (fmt === "json") return NextResponse.json(inviteJson(ctx, token), { headers: cache });
  if (fmt === "txt") return new NextResponse(inviteText(ctx, token), { headers: { ...cache, "content-type": "text/plain; charset=utf-8" } });
  if (fmt === "ics") return new NextResponse(inviteIcs(ctx, token), { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="${ctx.party.slug}.ics"` } });
  return new NextResponse(renderInvitePage(ctx, token), { headers: { ...cache, "content-type": "text/html; charset=utf-8" } });
}
