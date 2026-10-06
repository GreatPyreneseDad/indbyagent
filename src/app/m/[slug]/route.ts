// GET /m/<slug>[?c=<room>]      -> HTML (browser) or JSON (Accept: application/json)
// GET /m/<slug>.json|.txt
// Public, read-only. The card owner's QR points here.
import { NextRequest, NextResponse } from "next/server";
import { loadCard, resolveContext, cardJson, cardText } from "@/lib/meet";
import { renderMeetPage } from "@/lib/meet-page";
import { notFound, wantsJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  let { slug } = await params;
  let fmt: "html" | "json" | "txt" = wantsJson(req) ? "json" : "html";
  const m = slug.match(/^(.*)\.(json|txt)$/);
  if (m) { slug = m[1]; fmt = m[2] as "json" | "txt"; }
  const card = await loadCard(slug);
  if (!card) return fmt === "html" ? new NextResponse(renderMeetPage(null, null, null), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }) : notFound();
  const code = req.nextUrl.searchParams.get("c");
  const ctx = await resolveContext(card, code);
  const headers = { "cache-control": "private, max-age=30", vary: "accept" };
  if (fmt === "json") return NextResponse.json(cardJson(card, ctx), { headers });
  if (fmt === "txt") return new NextResponse(cardText(card, ctx), { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  const saved = req.nextUrl.searchParams.get("saved");
  const notice = saved === "1" ? `Done. ${card.display_name.split(" ")[0]}'s agent is writing to yours now. Check that inbox in a minute.` : undefined;
  return new NextResponse(renderMeetPage(card, ctx, code, notice), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}
