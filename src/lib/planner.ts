import Anthropic from "@anthropic-ai/sdk";
import { db, type Party, type PlanningMessage, type Poll } from "./db";
import { anthropic, MODEL } from "./parse";
import { fmtWhen } from "./invite";

// A chat between the host and Claude about one party. Each turn Claude asks
// the next useful question, and returns what it learned (saved to
// parties.planning) plus any polls the host agreed to send to the yeses.

const MAX_TOPICS = 40;

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    facts: { type: "array", items: { type: "object", additionalProperties: false, properties: { topic: { type: "string" }, value: { type: "string" } }, required: ["topic", "value"] } },
    polls: { type: "array", items: { type: "object", additionalProperties: false, properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question", "options"] } },
  },
  required: ["reply", "facts", "polls"],
};

const KICKOFF = "(I just created this event. Start planning with me.)";

function systemPrompt(party: Party, polls: Poll[]) {
  const notes = Object.entries(party.planning ?? {}).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "(nothing yet)";
  const pollList = polls.map((p) => `- ${p.question}${p.kind === "date_rank" ? " (ranked date poll)" : ` [${p.options.join(" | ")}]`}`).join("\n") || "(none)";
  return `You are the planning assistant for a host organizing an event on IndbyAgent. Chat with the host to learn what's needed to plan it well.
Ask ONE short, specific question per turn, building on what you know. Cover what matters for this kind of event: purpose and audience, expected headcount, budget, food and drinks, dietary needs, theme or vibe, schedule and activities, venue logistics (parking, accessibility, weather backup), supplies, and helpers. Skip anything already known. When you have a good picture, say so, give a brief plan summary, and invite the host to add anything else.
Guests can be sent polls, shown only after they RSVP yes (e.g. "Pizza or tacos?"). When a question is better answered by the guests, suggest a poll. Only put a poll in "polls" after the host has agreed to it in this conversation; 2-8 short options, never one that already exists. Date polls are set up by the host in the event form, not by you.

Output fields:
- reply: your message to the host (plain text, friendly, under 80 words).
- facts: everything new or changed the host told you in their latest message, as topic/value pairs. topic is a short snake_case key (guest_count, audience, budget, food, drinks, dietary, theme, schedule, activities, venue, parking, accessibility, weather_backup, supplies, helpers, notes, or another clear key). value is a concise summary in the host's terms. Reuse an existing topic to update it. Use value "" to remove a topic the host retracts. Do not invent facts.
- polls: polls to create now, else [].

Event:
- title: ${party.title}${party.kind ? `\n- kind: ${party.kind}` : ""}
- when: ${fmtWhen(party)}${party.location ? `\n- where: ${party.location}` : ""}${party.details ? `\n- details: ${party.details}` : ""}
Saved planning notes:
${notes}
Existing polls:
${pollList}`;
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
  const { data } = await db.from("planning_messages").select("*").eq("party_id", partyId).order("created_at");
  return (data ?? []) as PlanningMessage[];
}

// One turn: save the host's message (if any), ask Claude, save its reply,
// merge facts into the party and create agreed polls.
export async function planTurn(partyId: string, text?: string) {
  if (text) await db.from("planning_messages").insert({ party_id: partyId, role: "user", text });
  const [{ data: party }, { data: polls }, history] = await Promise.all([
    db.from("parties").select("*").eq("id", partyId).single(),
    db.from("polls").select("*").eq("party_id", partyId).order("created_at"),
    loadPlanning(partyId),
  ]);
  if (!party) throw new Error("party not found");
  const existing = (polls ?? []) as Poll[];

  const t0 = Date.now();
  const res: Anthropic.Message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    thinking: { type: "between_tools" },
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system: systemPrompt(party as Party, existing),
    messages: toMessages(history),
  } as Anthropic.MessageCreateParamsNonStreaming);
  const u = res.usage;
  await db.from("llm_calls").insert({ party_id: partyId, purpose: "planning", model: MODEL, effort: "low", input_tokens: u.input_tokens, cache_read_tokens: u.cache_read_input_tokens ?? 0, output_tokens: u.output_tokens, ms: Date.now() - t0 });
  const textBlock = res.content.find((b) => b.type === "text");
  const j = JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "{}") as { reply?: string; facts?: { topic: string; value: string }[]; polls?: { question: string; options: string[] }[] };

  const planning: Record<string, string> = { ...((party as Party).planning ?? {}) };
  for (const f of j.facts ?? []) {
    const topic = String(f.topic ?? "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (!topic) continue;
    const value = String(f.value ?? "").trim().slice(0, 500);
    if (!value) delete planning[topic];
    else if (topic in planning || Object.keys(planning).length < MAX_TOPICS) planning[topic] = value;
  }
  await db.from("parties").update({ planning }).eq("id", partyId);

  const created: Poll[] = [];
  const seen = new Set(existing.map((p) => p.question.trim().toLowerCase()));
  for (const p of j.polls ?? []) {
    const question = String(p.question ?? "").trim().slice(0, 200);
    const options = [...new Set((p.options ?? []).map((o) => String(o).trim().slice(0, 60)).filter(Boolean))].slice(0, 8);
    if (!question || options.length < 2 || seen.has(question.toLowerCase())) continue;
    const { data } = await db.from("polls").insert({ party_id: partyId, question, options, created_by: "agent" }).select().single();
    if (data) { created.push(data as Poll); seen.add(question.toLowerCase()); }
  }

  const reply = String(j.reply ?? "").trim() || "Got it. Anything else I should know about the event?";
  await db.from("planning_messages").insert({ party_id: partyId, role: "assistant", text: reply });
  return { messages: await loadPlanning(partyId), planning, polls_created: created };
}
