// Host side of Meet. GET: my cards with contexts and every drop. POST: create or update a card.
import { NextRequest, NextResponse } from "next/server";
import { unauthorized } from "@/lib/host";
import { currentHost } from "@/lib/auth";
import { parseBody } from "@/lib/http";
import { CardBody, listCards, listContexts, listMeets, upsertCard, cardUrl } from "@/lib/meet";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  try {
    const cards = await listCards(host.id);
    const out = await Promise.all(cards.map(async (c) => ({ ...c, url: cardUrl(c), qr: `${cardUrl(c)}/qr`, contexts: await listContexts(c.id), meets: await listMeets(c.id) })));
    return NextResponse.json({ cards: out }, { headers: { "cache-control": "no-store" } });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 503 }); }
}

export async function POST(req: NextRequest) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const p = await parseBody(req, CardBody);
  if ("res" in p) return p.res;
  try {
    const card = await upsertCard(host.id, CardBody.parse(p.data));
    return NextResponse.json({ card, url: cardUrl(card), qr: `${cardUrl(card)}/qr` }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 409 }); }
}
