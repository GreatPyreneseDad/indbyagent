// GET /v/<token>            -> HTML (browser) or JSON (Accept: application/json)
// GET /v/<token>.json|.txt
// GET never changes anything.
import { NextRequest, NextResponse } from "next/server";
import { requestJson, requestText } from "@/lib/vendor-requests";
import { renderVendorPage } from "@/lib/vendor-page";
import { loadCtx } from "@/lib/vendor-http";
import { notFound, wantsJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  let { token } = await params;
  let fmt: "html" | "json" | "txt" = wantsJson(req) ? "json" : "html";
  const m = token.match(/^(.*)\.(json|txt)$/);
  if (m) { token = m[1]; fmt = m[2] as "json" | "txt"; }
  const ctx = await loadCtx(token);
  if (!ctx) return fmt === "html" ? new NextResponse(renderVendorPage(null, token), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }) : notFound();
  const cache = { "cache-control": "private, max-age=30", vary: "accept" };
  if (fmt === "json") return NextResponse.json(requestJson(ctx, token), { headers: cache });
  if (fmt === "txt") return new NextResponse(requestText(ctx, token), { headers: { ...cache, "content-type": "text/plain; charset=utf-8" } });
  const q = req.nextUrl.searchParams;
  const notice = q.get("saved") === "quote" ? "Quote sent. The host will confirm in writing before anything is booked." : q.get("saved") === "decline" ? "Thanks, we've let the host know." : q.get("saved") === "message" ? "Sent to the host." : undefined;
  return new NextResponse(renderVendorPage(ctx, token, notice), { headers: { ...cache, "content-type": "text/html; charset=utf-8" } });
}
