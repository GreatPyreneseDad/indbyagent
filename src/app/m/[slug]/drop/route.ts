// POST /m/<slug>/drop — someone who scanned the card drops their agent's address.
// Form (browser) or JSON (agent). Stores the meet and sends the intro from the
// card owner's inbox. Returns the meet document to agents; redirects browsers.
import { NextRequest, NextResponse } from "next/server";
import { DropBody, loadCard, resolveContext, createMeet, SCOPES } from "@/lib/meet";
import { sendMeetIntro } from "@/lib/meet-mail";
import { notFound, parseBody } from "@/lib/http";

export const dynamic = "force-dynamic";
const isForm = (req: NextRequest) => (req.headers.get("content-type") ?? "").includes("form");

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const card = await loadCard(slug);
  if (!card) return notFound();
  let data: import("zod").output<typeof DropBody>;
  if (isForm(req)) {
    const f = await req.formData();
    const scopes = f.getAll("scopes").map(String).filter((s) => (SCOPES as readonly string[]).includes(s));
    const r = DropBody.safeParse({
      agent_address: String(f.get("agent_address") ?? ""), name: String(f.get("name") ?? "") || undefined,
      note: String(f.get("note") ?? "") || undefined, wants: String(f.get("wants") ?? "") || undefined,
      scopes: scopes.length ? scopes : ["follow_up"], context: String(f.get("context") ?? "") || undefined, by: { kind: "human" },
    });
    if (!r.success) return NextResponse.json({ error: "invalid", issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
    data = r.data;
  } else {
    const p = await parseBody(req, DropBody);
    if ("res" in p) return p.res;
    data = DropBody.parse(p.data);
  }
  const ctx = await resolveContext(card, data.context);
  const meet = await createMeet(card, ctx, data);
  const sent = await sendMeetIntro(card, meet).catch((e: Error) => ({ error: e.message }));
  if (isForm(req)) return NextResponse.redirect(new URL(`/m/${slug}?saved=1${data.context ? `&c=${encodeURIComponent(data.context)}` : ""}`, req.url), 303);
  return NextResponse.json({ "@type": "IndbyAgent/Meet.Dropped", meet_id: meet.id, status: "error" in sent ? "dropped" : "sent", intro: sent, next: `watch ${meet.agent_address} for a message from ${card.inbox_address ?? "the card owner"} with subject tag [IndbyAgent M-${meet.id.slice(0, 8)}]` }, { status: 201, headers: { "cache-control": "no-store" } });
}
