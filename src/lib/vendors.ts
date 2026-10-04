import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { db, type GuestState, type Party, type Poll } from "./db";
import { anthropic, MODEL } from "./parse";
import { fmtDate } from "./invite";
import { tallyRanked } from "./host";
import { fallback } from "./fallback";
import { store } from "./store";

// A guest's ranked answer to the party's "dates" poll (from poll_state).
export type DateRanking = { guest_id: string; ranking: string[] };

// The venue and vendor agent, and the only module that talks to Neon
// (NEON_DATABASE_URL, schema in neon/migrations). Callers must have checked
// currentHost + hostOwnsParty; queries are still scoped to party and host.
// Host-facing only: nothing here reaches the guest invite.

export type VenueStatus = "pending" | "confirmed" | "rejected";
export type VenueSuggestion = {
  id: string; party_id: string; host_id: string; status: VenueStatus; created_at: string; decided_at: string | null;
  target_time: string;
  venue: { name: string; address: string; url: string | null; why: string; capacity_fit: string; est_cost: string | null };
  // From published hours and booking info. "open" is not a confirmed booking.
  availability: { status: "open" | "closed" | "unknown"; evidence: string; booking_url: string | null };
  invitees: { available: string[]; unavailable: string[]; unknown: string[] };
  vendors: { category: string; name: string; url: string | null; why: string }[];
  sources: string[];
  mock: boolean;
};
type NewSuggestion = Omit<VenueSuggestion, "id" | "status" | "created_at" | "decided_at">;

// ---------- storage ----------

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
type Row = Omit<VenueSuggestion, "created_at" | "decided_at" | "target_time"> & { created_at: unknown; decided_at: unknown; target_time: unknown };
const fromRow = (r: Row): VenueSuggestion => ({ ...r, created_at: iso(r.created_at)!, decided_at: iso(r.decided_at), target_time: iso(r.target_time)! });

// Outside dev a missing NEON_DATABASE_URL throws here, on the first vendor call.
function sql() {
  const url = process.env.NEON_DATABASE_URL;
  if (!url) throw new Error("NEON_DATABASE_URL is not set; venue suggestions need the Neon database");
  return neon(url);
}

const g = globalThis as typeof globalThis & { __indbyagentVenues?: VenueSuggestion[] };
const mem = (g.__indbyagentVenues ??= []);

export async function listSuggestions(partyId: string, hostId: string): Promise<VenueSuggestion[]> {
  if (fallback.neon) return mem.filter((s) => s.party_id === partyId && s.host_id === hostId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows = await sql()`select * from venue_suggestions where party_id = ${partyId} and host_id = ${hostId} order by created_at desc`;
  return (rows as Row[]).map(fromRow);
}

async function addSuggestion(s: NewSuggestion): Promise<VenueSuggestion> {
  const v: VenueSuggestion = { ...s, id: randomUUID(), status: "pending", created_at: new Date().toISOString(), decided_at: null };
  if (fallback.neon) { mem.push(v); return v; }
  const [row] = await sql()`insert into venue_suggestions (id, party_id, host_id, status, target_time, venue, availability, invitees, vendors, sources, mock, created_at)
    values (${v.id}, ${v.party_id}, ${v.host_id}, 'pending', ${v.target_time}, ${JSON.stringify(v.venue)}, ${JSON.stringify(v.availability)},
      ${JSON.stringify(v.invitees)}, ${JSON.stringify(v.vendors)}, ${JSON.stringify(v.sources)}, ${v.mock}, ${v.created_at})
    returning *`;
  return fromRow(row as Row);
}

// Only pending suggestions can be decided. One confirmed venue per party: a
// new confirmation turns the previous one into rejected.
export async function decideSuggestion(partyId: string, hostId: string, id: string, status: "confirmed" | "rejected"): Promise<VenueSuggestion | { error: string }> {
  const current = (await listSuggestions(partyId, hostId)).find((s) => s.id === id);
  if (!current) return { error: "not found" };
  if (current.status !== "pending") return { error: `already ${current.status}` };
  const now = new Date().toISOString();
  if (fallback.neon) {
    if (status === "confirmed") for (const s of mem) if (s.party_id === partyId && s.status === "confirmed") Object.assign(s, { status: "rejected", decided_at: now });
    const s = mem.find((x) => x.id === id)!;
    Object.assign(s, { status, decided_at: now });
    return { ...s };
  }
  const q = sql();
  const results = await q.transaction([
    ...(status === "confirmed" ? [q`update venue_suggestions set status = 'rejected', decided_at = ${now} where party_id = ${partyId} and host_id = ${hostId} and status = 'confirmed'`] : []),
    q`update venue_suggestions set status = ${status}, decided_at = ${now} where id = ${id} and party_id = ${partyId} and host_id = ${hostId} and status = 'pending' returning *`,
  ]);
  const [row] = results[results.length - 1] as Row[];
  return row ? fromRow(row) : { error: "already decided" };
}

// What the planning chat knows about venues. Never throws: the planner keeps
// working if Neon is down or unset.
export async function venueContext(partyId: string, hostId: string): Promise<string> {
  try {
    const list = await listSuggestions(partyId, hostId);
    const confirmed = list.find((s) => s.status === "confirmed");
    const pending = list.filter((s) => s.status === "pending");
    const rejected = list.filter((s) => s.status === "rejected").map((s) => s.venue.name);
    return [
      confirmed ? `Confirmed venue: ${confirmed.venue.name}, ${confirmed.venue.address}.` : "No venue confirmed yet.",
      ...pending.map((s) => `Waiting for the host: ${s.venue.name} (${s.availability.status} at the target time; ${s.invitees.available.length} invitees can make it).`),
      rejected.length ? `Rejected: ${rejected.join("; ")}.` : "",
      ...(confirmed?.vendors ?? []).map((v) => `Vendor idea (${v.category}): ${v.name}.`),
    ].filter(Boolean).join("\n");
  } catch (e) {
    console.error("venueContext:", (e as Error).message);
    return "Venue info unavailable.";
  }
}

// ---------- the agent ----------

// The date to plan around: the leading date in the ranked poll, else the
// party's own date. Null when neither exists yet.
export function targetTime(party: Party, datePoll: Poll | null, rankings: DateRanking[]): string | null {
  if (datePoll && rankings.length) return tallyRanked(datePoll.options, rankings).winner ?? party.starts_at;
  return party.starts_at ?? datePoll?.options[0] ?? null;
}

// A ranking lists every date a guest can make, so a date left off means "can't".
// Without a ranking, only a yes or no for the original date counts.
export function inviteeAvailability(guests: GuestState[], at: string, datePoll: Poll | null, rankings: DateRanking[], startsAt: string | null) {
  const out = { available: [] as string[], unavailable: [] as string[], unknown: [] as string[] };
  const same = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();
  for (const g of guests) {
    const r = datePoll ? rankings.find((x) => x.guest_id === g.guest_id) : undefined;
    if (r) (r.ranking.some((o) => same(o, at)) ? out.available : out.unavailable).push(g.name);
    else if (g.status === "no" && startsAt && same(at, startsAt)) out.unavailable.push(g.name);
    else if (g.status === "yes" && startsAt && same(at, startsAt)) out.available.push(g.name);
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

type Found = Pick<NewSuggestion, "venue" | "availability" | "vendors" | "sources">;

async function searchWithClaude(client: Anthropic, partyId: string, brief: string): Promise<Found> {
  const system = `You find a venue and a few vendors for a party, using web search. Output only the JSON object.
Pick ONE venue near the party's area that fits the guest count, budget and theme, and that is open at the target time. Check its published opening hours (and whether it hosts private parties or takes bookings) for that weekday and time. Pick a venue that is not in the rejected or already-suggested lists.
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
  return {
    venue: { name: pick.name, address: `Near ${party.location ?? "your area"}`, url: null, why: pick.why, capacity_fit: "Fits about 30 people (mock)", est_cost: "$150-$300 (mock)" },
    availability: { status: open ? "open" : "closed", evidence: `Mock hours 9 AM-8 PM; the party is at ${fmtDate(at, party.timezone)}.`, booking_url: null },
    vendors: [
      { category: "cake", name: "Corner Bakery (mock)", url: null, why: "Custom birthday cakes with 3 days' notice." },
      { category: "entertainment", name: "Balloon Bob (mock)", url: null, why: "Balloon animals and games for kids, 1-2 hours." },
    ],
    sources: [],
  };
}

export async function suggestVenue(partyId: string, hostId: string): Promise<VenueSuggestion> {
  const [{ data: party }, { data: guests }, { data: polls }, notes, past] = await Promise.all([
    db.from("parties").select("*").eq("id", partyId).single(),
    db.from("guest_state").select("*").eq("party_id", partyId).order("name"),
    db.from("polls").select("*").eq("party_id", partyId).eq("kind", "dates").order("created_at", { ascending: false }).limit(1),
    store.planningNotes(partyId),
    listSuggestions(partyId, hostId),
  ]);
  if (!party) throw new Error("party not found");
  const p = party as Party;
  const datePoll = ((polls ?? [])[0] as Poll | undefined) ?? null;
  let rankings: DateRanking[] = [];
  if (datePoll) {
    const { data: rows } = await db.from("poll_state").select("guest_id,choice,ranking").eq("poll_id", datePoll.id).not("choice", "is", null);
    rankings = (rows ?? []).map((r) => ({ guest_id: r.guest_id as string, ranking: (r.ranking as string[] | null) ?? [r.choice as string] }));
  }
  const at = targetTime(p, datePoll, rankings);
  if (!at) throw new Error("no date yet: set a date or open a dates poll first");
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
  return addSuggestion({ party_id: partyId, host_id: hostId, target_time: at, invitees, mock, ...found });
}
