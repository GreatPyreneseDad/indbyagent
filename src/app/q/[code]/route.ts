// Big-screen page: QR code + live counters. Public, read-only.
import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { loadJoin, joinUrl } from "@/lib/join";
import { renderScreenPage } from "@/lib/join-page";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const party = await loadJoin(code);
  if (!party) return NextResponse.json({ error: "not found" }, { status: 404 });
  const url = joinUrl(code);
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0b0a0b", light: "#ffffff" } });
  return new NextResponse(renderScreenPage(party, code, url, svg), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
