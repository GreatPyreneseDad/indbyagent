import Anthropic from "@anthropic-ai/sdk";
import { db, type GuestState, type Party } from "./db";
import { anthropic, MODEL } from "./parse";
import { fmtDate } from "./invite";
import { instantRunoff } from "./ranked";
import { store, type DateRanking, type DatePoll, type NewVenueSuggestion, type VenueSuggestion } from "./store";

// The venue agent: picks the time the party is most likely to happen, works
// out which invitees can make it, then searches the web for a venue that is
// open then (plus a few vendors) and hands the host one suggestion to confirm
// or reject.

export function targetTime(party: Party, datePoll: DatePoll | null, rankings: DateRanking[]): string {
  if (!datePoll || !rankings.length) return party.starts_at;
  return instantRunoff(datePoll.options, rankings.map((r) => r.ranking)).winner ?? party.starts_at;
}

// A ranking lists every date a guest can make, so a date left off means "can't".
// Without a ranking, only a yes for the original date counts as available.
export function inviteeAvailability(guests: GuestState[], at: string, datePoll: DatePoll | null, rankings: DateRanking[], startsAt: string) {
  const out = { available: [] as string[], unavailable: [] as string[], unknown: [] as string[] };
  const same = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();
  for (const g of guests) {
    const r = datePoll ? rankings.find((x) => x.guest_id === g.guest_id) : undefined;
    if (r) (r.ranking.some((o) => same(o, at)) ? out.available : out.unavailable).push(g.name);
    else if (g.status === "no" && same(at, startsAt)) out.unavailable.push(g.name);
    else if (g.status === "yes" && same(at, startsAt)) out.available.push(g.name);
    else out.unknown.push(g.name);
  }
  return out;
}

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    venue: {
      type: "object", additionalProperties: false,
      properties: {
        name: { type: "string" }, address: { type: "string" }, url: { type: ["string", "null"] },
        why: { type: "string" }, capacity_fit: { type: "string" }, est_cost: { type: ["string", "null"] },
      },
      required: ["name", "address", "url", "why", "capacity_fit", "est_cost"],
    },
    availability: {
      type: "object", additionalProperties: false,
      properties: { status: { type: "string", enum: ["open", "closed", "unknown"] }, evidence: { type: "string" }, booking_url: { type: ["string", "null"] } },
      required: ["status", "evidence", "booking_url"],
    },
    vendors: {
      type: "array",
      items: { type: "object", additionalProperties: false, properties: { category: { type: "string" }, name: { type: "string" }, url: { type: ["string", "null"] }, why: { type: "string" } }, required: ["category", "name", "url", "why"] },
    },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["venue", "availability", "vendors", "sources"],
};

type Found = Pick<NewVenueSuggestion, "venue" | "availability" | "vendors" | "sources">;

async function searchWithClaude(client: Anthropic, partyId: string, brief: string): Promise<Found> {
  const system = `You find a venue and a few vendors for a party, using web search. Output only the JSON object.
Pick ONE venue near the party's area that fits the guest count, budget and theme, and that is open at the target time. Check its published opening hours (and whether it hosts private parties or takes bookings) for that weekday and time. Avoid venues the host already rejected.
availability.status: "open" only if published hours cover the target time, "closed" if they don't, "unknown" if you can't find hours. evidence: quote or summarize what the source says, naming the source. You cannot see bookings, so never claim the venue is free or reserved; put a booking or contact link in booking_url when you find one.
vendors: up to 3 local vendors the party needs (e.g. bakery for the cake, entertainer, party supplies or decorations), skipping anything the notes say is already handled.
sources: the URLs you relied on. Do not invent venues, addresses, URLs or hours.`;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: brief }];
  const t0 = Date.now();
  let usage = { input: 0, cached: 0, output: 0 };
  let res: Anthropic.Message | null = null;
  // Server-side search can pause a long turn; continue it a few times.
  for (let i = 0; i < 4; i++) {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: "between_tools" },
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      system,
      messages,
    } as Anthropic.MessageCreateParamsNonStreaming);
    usage = { input: usage.input + res.usage.input_tokens, cached: usage.cached + (res.usage.cache_read_input_tokens ?? 0), output: usage.output + res.usage.output_tokens };
    if (res.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: res.content });
  }
  await db.from("llm_calls").insert({ party_id: partyId, purpose: "venue_search", model: MODEL, effort: "low", input_tokens: usage.input, cache_read_tokens: usage.cached, output_tokens: usage.output, ms: Date.now() - t0 });
  const texts = (res?.content ?? []).filter((b): b is Anthropic.TextBlock => b.type === "text");
  const j = JSON.parse(texts[texts.length - 1]?.text ?? "{}") as Found;
  if (!j.venue?.name) throw new Error("venue search returned no venue");
  return {
    venue: { ...j.venue, name: j.venue.name.slice(0, 120), address: String(j.venue.address ?? "").slice(0, 200), why: String(j.venue.why ?? "").slice(0, 400) },
    availability: { status: ["open", "closed", "unknown"].includes(j.availability?.status) ? j.availability.status : "unknown", evidence: String(j.availability?.evidence ?? "").slice(0, 400), booking_url: j.availability?.booking_url ?? null },
    vendors: (j.vendors ?? []).slice(0, 3),
    sources: (j.sources ?? []).filter((s) => /^https?:\/\//.test(s)).slice(0, 8),
  };
}

// Without Claude (local testing): clearly fake results, rotated so each
// search gives a different one. Open 9am-8pm in the party's timezone.
const MOCK_VENUES = [
  { name: "Sunny Side Community Room (mock)", why: "Indoor room with tables, a kitchenette, and space for games." },
  { name: "Maple Park Picnic Pavilion (mock)", why: "Covered pavilion next to a playground; good for kids running around." },
  { name: "Jumpin' Jungle Play Center (mock)", why: "Party packages with a private room and a host who runs activities." },
];

function mockSearch(party: Party, at: string, exclude: string[]): Found {
  const pick = MOCK_VENUES.find((v) => !exclude.includes(v.name)) ?? MOCK_VENUES[0];
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: party.timezone }).format(new Date(at)));
  const open = hour >= 9 && hour < 20;
  const area = party.location ?? "your area";
  return {
    venue: { name: pick.name, address: `Near ${area}`, url: null, why: pick.why, capacity_fit: "Fits about 30 people (mock)", est_cost: "$150-$300 (mock)" },
    availability: { status: open ? "open" : "closed", evidence: `Mock hours 9 AM-8 PM; the party is at ${fmtDate(at, party.timezone)}.`, booking_url: null },
    vendors: [
      { category: "cake", name: "Corner Bakery (mock)", url: null, why: "Custom birthday cakes with 3 days' notice." },
      { category: "entertainment", name: "Balloon Bob (mock)", url: null, why: "Balloon animals and games for kids, 1-2 hours." },
    ],
    sources: [],
  };
}

export async function suggestVenue(partyId: string): Promise<VenueSuggestion> {
  const [{ data: party }, { data: guests }, datePoll, notes, past] = await Promise.all([
    db.from("parties").select("*").eq("id", partyId).single(),
    db.from("guest_state").select("*").eq("party_id", partyId).order("name"),
    store.datePoll(partyId),
    store.planningNotes(partyId),
    store.venueSuggestions(partyId),
  ]);
  if (!party) throw new Error("party not found");
  const p = party as Party;
  const rankings = datePoll ? await store.rankings(datePoll.id) : [];
  const at = targetTime(p, datePoll, rankings);
  const invitees = inviteeAvailability((guests ?? []) as GuestState[], at, datePoll, rankings, p.starts_at);
  const rejected = past.filter((s) => s.status === "rejected").map((s) => s.venue.name);
  const suggested = past.map((s) => s.venue.name);

  let found: Found, mock = false;
  if (anthropic) {
    const noteList = Object.entries(notes).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "(none)";
    const brief = `Party: ${p.title}${p.kind ? ` (${p.kind})` : ""}
Area: ${p.location ?? "not given (use any area hints in the notes)"}
Target time: ${fmtDate(at, p.timezone)} (${at}), timezone ${p.timezone}
Invitees: ${(guests ?? []).length} invited, ${invitees.available.length} can make this time, ${invitees.unknown.length} unknown
${p.details ? `Details: ${p.details}\n` : ""}Host's planning notes:
${noteList}
Venues the host rejected: ${rejected.join("; ") || "(none)"}
Already suggested (pick a different one): ${suggested.join("; ") || "(none)"}`;
    found = await searchWithClaude(anthropic, partyId, brief);
  } else {
    found = mockSearch(p, at, suggested);
    mock = true;
  }
  return store.addVenueSuggestion({ party_id: partyId, target_time: at, invitees, mock, ...found });
}
