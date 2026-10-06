// POST: add or update a room (QR context) on my card. Returns the QR url for that room.
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost } from "@/lib/auth";
import { parseBody, notFound } from "@/lib/http";
import { ContextBody, loadCard, upsertContext, cardUrl } from "@/lib/meet";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { slug } = await params;
  const card = await loadCard(slug);
  if (!card) return notFound();
  if (card.host_id !== host.id) return forbidden();
  const p = await parseBody(req, ContextBody);
  if ("res" in p) return p.res;
  const ctx = await upsertContext(card.id, p.data);
  return NextResponse.json({ context: ctx, url: cardUrl(card, ctx.code), qr: `${cardUrl(card).replace(/\?.*$/, "")}/qr?c=${encodeURIComponent(ctx.code)}` }, { status: 201, headers: { "cache-control": "no-store" } });
}
