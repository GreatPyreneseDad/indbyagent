// GET /m/<slug>/qr[?c=<room>][&svg=1] — the owner's QR for a lock screen or a table tent.
import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { loadCard, resolveContext, cardUrl } from "@/lib/meet";
import { renderQrPage } from "@/lib/meet-page";
import { notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const card = await loadCard(slug);
  if (!card) return notFound();
  const code = req.nextUrl.searchParams.get("c");
  const ctx = await resolveContext(card, code);
  const url = cardUrl(card, code);
  if (req.nextUrl.searchParams.get("png")) {
    const buf = await QRCode.toBuffer(url, { type: "png", width: 1024, margin: 2, errorCorrectionLevel: "M", color: { dark: "#0b0a0b", light: "#ffffff" } });
    return new NextResponse(new Uint8Array(buf), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  }
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0b0a0b", light: "#ffffff" } });
  if (req.nextUrl.searchParams.get("svg")) return new NextResponse(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
  return new NextResponse(renderQrPage(card, ctx, url, svg), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
