import Anthropic from "@anthropic-ai/sdk";
import { db, type Party, type Poll } from "./db";
import { anthropic, MODEL } from "./parse";
import { fmtWhen } from "./invite";
import { store, type DatePoll, type PlanningMessage } from "./store";
import { venueContext } from "./vendors";

// A chat between the host and Claude about one party. Each turn Claude asks
// the next useful question and returns what it learned (kept as the party's
// planning notes in ./store) plus polls it suggests. Suggestions are only
// returned; the host opens them from the board. It also sees the venue agent's
// results and can ask the board to run a venue search (find_venue).

const MAX_TOPICS = 40;

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    facts: { type: "array", items: { type: "object", additionalProperties: false, properties: { topic: { type: "string" }, value: { type: "string" } }, required: ["topic", "value"] } },
    polls: { type: "array", items: { type: "object", additionalProperties: false, properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question", "options"] } },
    find_venue: { type: "boolean" },
  },
  required: ["reply", "facts", "polls", "find_venue"],
};

export type SuggestedPoll = { question: string; options: string[] };

const KICKOFF = "(I just created this event. Start planning with me.)";

function systemPrompt(party: Party, notes: Record<string, string>, polls: Poll[], datePoll: DatePoll | null, venues: string) {
  const noteList = Object.entries(notes).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "(nothing yet)";
  const pollList = [
    ...(datePoll ? [`- ${datePoll.question} (ranked date poll)`] : []),
    ...polls.map((p) => `- ${p.question} [${p.options.join(" | ")}]`),
  ].join("\n") || "(none)";
  return `You are the planning assistant for a host organizing an event on IndbyAgent. Chat with the host to learn what's needed to plan it well.
Ask ONE short, specific question per turn, building on what you know. Cover what matters for this kind of event: purpose and audience, expected headcount, budget, food and drinks, dietary needs, theme or vibe, schedule and activities, venue logistics (parking, accessibility, weather backup), supplies, and helpers. Skip anything already known. When you have a good picture, say so, give a brief plan summary, and invite the host to add anything else.
Guests can be sent polls, shown only after they RSVP yes (e.g. "Pizza or tacos?"). When a question is better answered by the guests, suggest a poll in "polls" (2-8 short options, never one that already exists) and tell the host they can open it from the suggestion. Date polls are set up by the host in the event form, not by you.
A venue agent can search for a venue open at the party time (with vendor ideas) and check which invitees can make it; the host confirms or rejects its pick. Set find_venue true when the host wants a venue found or another option, or agrees to your offer to search; otherwise false. Don't name specific venues yourself.

Output fields:
- reply: your message to the host (plain text, friendly, under 80 words).
- facts: everything new or changed the host told you in their latest message, as topic/value pairs. topic is a short snake_case key (guest_count, audience, budget, food, drinks, dietary, theme, schedule, activities, venue, parking, accessibility, weather_backup, supplies, helpers, notes, or another clear key). value is a concise summary in the host's terms. Reuse an existing topic to update it. Use value "" to remove a topic the host retracts. Do not invent facts.
- polls: polls to suggest this turn, else [].
- find_venue: true to start a venue search now.

Event:
- title: ${party.title}${party.kind ? `\n- kind: ${party.kind}` : ""}
- when: ${fmtWhen(party)}${party.location ? `\n- where: ${party.location}` : ""}${party.details ? `\n- details: ${party.details}` : ""}
Planning notes so far:
${noteList}
Existing polls:
${pollList}
Venue:
${venues}`;
}

// Claude needs strictly alternating turns starting with the user.
function toMessages(history: PlanningMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [{ role: "user", content: KICKOFF }];
  for (const m of history) {
    const last = out[out.length - 1];
    if (last.role === m.role) last.content = `${last.content}\n\n${m.text}`;
    else out.push({ role: m.role, content: m.text });
  }
  return out;
}

export async function loadPlanning(partyId: string) {
  const [messages, planning] = await Promise.all([store.planningMessages(partyId), store.planningNotes(partyId)]);
  return { messages, planning };
}

// One turn: record the host's message (if any), ask Claude, record its reply
// and merge what it learned into the planning notes.
export async function planTurn(partyId: string, hostId: string, text?: string) {
  if (text) await store.addPlanningMessage(partyId, "user", text);
  const [{ data: party }, { data: polls }, datePoll, { messages: history, planning: notes }, venues] = await Promise.all([
    db.from("parties").select("*").eq("id", partyId).single(),
    db.from("polls").select("*").eq("party_id", partyId).order("created_at"),
    store.datePoll(partyId),
    loadPlanning(partyId),
    venueContext(partyId, hostId),
  ]);
  if (!party) throw new Error("party not found");
  const existing = (polls ?? []) as Poll[];
  if (!anthropic) return scriptedTurn(partyId, history, notes, text);

  const t0 = Date.now();
  const res: Anthropic.Message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    thinking: { type: "between_tools" },
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system: systemPrompt(party as Party, notes, existing, datePoll, venues),
    messages: toMessages(history),
  } as Anthropic.MessageCreateParamsNonStreaming);
  const u = res.usage;
  await db.from("llm_calls").insert({ party_id: partyId, purpose: "planning", model: MODEL, effort: "low", input_tokens: u.input_tokens, cache_read_tokens: u.cache_read_input_tokens ?? 0, output_tokens: u.output_tokens, ms: Date.now() - t0 });
  const textBlock = res.content.find((b) => b.type === "text");
  const j = JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "{}") as { reply?: string; facts?: { topic: string; value: string }[]; polls?: SuggestedPoll[]; find_venue?: boolean };

  const planning = { ...notes };
  for (const f of j.facts ?? []) {
    const topic = String(f.topic ?? "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (!topic) continue;
    const value = String(f.value ?? "").trim().slice(0, 500);
    if (!value) delete planning[topic];
    else if (topic in planning || Object.keys(planning).length < MAX_TOPICS) planning[topic] = value;
  }
  await store.setPlanningNotes(partyId, planning);

  const seen = new Set(existing.map((p) => p.question.trim().toLowerCase()));
  const suggested_polls: SuggestedPoll[] = [];
  for (const p of j.polls ?? []) {
    const question = String(p.question ?? "").trim().slice(0, 200);
    const options = [...new Set((p.options ?? []).map((o) => String(o).trim().slice(0, 60)).filter(Boolean))].slice(0, 8);
    if (!question || options.length < 2 || seen.has(question.toLowerCase())) continue;
    suggested_polls.push({ question, options });
    seen.add(question.toLowerCase());
  }

  const reply = String(j.reply ?? "").trim() || "Got it. Anything else I should know about the event?";
  await store.addPlanningMessage(partyId, "assistant", reply);
  return { messages: await store.planningMessages(partyId), planning, suggested_polls, find_venue: j.find_venue === true, offline: false };
}

// Without Claude (local testing): fixed questions, and each host answer is
// saved under the topic of the question it replied to.
const SCRIPT: [topic: string, question: string][] = [
  ["audience", "Who is the event for, and roughly how many people are you expecting?"],
  ["budget", "What's your budget?"],
  ["food", "What food and drinks are you planning? Any dietary needs to plan around?"],
  ["theme", "Is there a theme or vibe?"],
  ["schedule", "What's the rough schedule, and what activities are planned?"],
  ["venue", "Any venue logistics: parking, accessibility, or a weather backup?"],
  ["helpers", "Who's helping, and what supplies do you still need?"],
];

async function scriptedTurn(partyId: string, history: PlanningMessage[], notes: Record<string, string>, text?: string) {
  const asked = history.filter((m) => m.role === "assistant").length;
  const planning = { ...notes };
  if (text && asked > 0) {
    const topic = SCRIPT[asked - 1]?.[0] ?? "notes";
    planning[topic] = (topic === "notes" && planning.notes ? `${planning.notes}; ${text}` : text).slice(0, 500);
    await store.setPlanningNotes(partyId, planning);
  }
  const wantsVenue = !!text && /\b(find|need|suggest|search|look for)\b.*\bvenue|\bvenue (ideas|options|search)/i.test(text);
  const next = SCRIPT[asked]?.[1];
  const reply = (wantsVenue ? "Starting a venue search; the suggestion will show up under Venue & vendors. " : "") + (asked === 0
    ? `Claude isn't configured here, so I'll ask scripted planning questions. ${next}`
    : next ?? "Thanks, that covers my questions. Anything else you tell me is saved under notes.");
  await store.addPlanningMessage(partyId, "assistant", reply);
  return { messages: await store.planningMessages(partyId), planning, suggested_polls: [] as SuggestedPoll[], find_venue: wantsVenue, offline: true };
}
