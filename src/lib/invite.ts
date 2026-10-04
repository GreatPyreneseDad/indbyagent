import { z } from "zod";
import { db, type Guest, type GuestState, type Party, type Poll, type PollAnswer, type InvitePoll, type InviteAnswer, type ByKind, type Channel } from "./db";
import { store } from "./store";
import { hashToken, looksLikeToken, siteUrl } from "./token";

export const SPEC_VERSION = "0.1";

// ---------- lookup ----------

// lockedPolls: how many polls the guest will see after saying yes. Date polls
// are shown to every invitee; all other polls only to the yeses.
export type InviteCtx = { party: Party; guest: Guest; state: GuestState; polls: InvitePoll[]; answers: InviteAnswer[]; lockedPolls: number };

export async function loadInvite(token: string): Promise<InviteCtx | null> {
  if (!looksLikeToken(token)) return null;
  const token_hash = hashToken(token);
  const { data: guest } = await db.from("guests").select("*").eq("token_hash", token_hash).maybeSingle();
  if (!guest || guest.token_revoked_at) return null;
  const [{ data: party }, { data: state }] = await Promise.all([
    db.from("parties").select("*").eq("id", guest.party_id).single(),
    db.from("guest_state").select("*").eq("guest_id", guest.id).single(),
  ]);
  if (!party || !state) return null;
  const [{ data: open }, datePoll] = await Promise.all([
    db.from("polls").select("*").eq("party_id", party.id).eq("status", "open").order("created_at"),
    store.datePoll(party.id),
  ]);
  const choicePolls = ((open ?? []) as Poll[]).map((p): InvitePoll => ({ ...p, kind: "choice" }));
  const yes = state.status === "yes";
  const polls: InvitePoll[] = [...(datePoll ? [datePoll] : []), ...(yes ? choicePolls : [])];
  const answers: InviteAnswer[] = [];
  if (yes && choicePolls.length) {
    const { data: a } = await db.from("poll_state").select("poll_id,guest_id,choice,note,by_kind,by_name,channel,answered_at")
      .eq("guest_id", guest.id).in("poll_id", choicePolls.map((x) => x.id));
    answers.push(...((a ?? []).map((r) => ({ ...r, created_at: r.answered_at })) as PollAnswer[]));
  }
  if (datePoll) {
    const mine = (await store.rankings(datePoll.id)).find((r) => r.guest_id === guest.id);
    if (mine) answers.push({ poll_id: datePoll.id, guest_id: guest.id, choice: mine.ranking[0], ranking: mine.ranking, note: null, by_kind: mine.by_kind, by_name: mine.by_name, channel: mine.channel, created_at: mine.created_at });
  }
  return { party: party as Party, guest: guest as Guest, state: state as GuestState, polls, answers, lockedPolls: yes ? 0 : choicePolls.length };
}

// ---------- the invite document (what an agent reads) ----------

export function inviteJson(ctx: InviteCtx, token: string) {
  const { party, guest, state, polls, answers, lockedPolls } = ctx;
  const base = `${siteUrl()}/i/${token}`;
  const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0)));
  const doc: Record<string, unknown> = {
    indbyagent: SPEC_VERSION,
    party: strip({
      title: party.title,
      kind: party.kind,
      starts_at: party.starts_at,
      ends_at: party.ends_at,
      timezone: party.timezone,
      location: party.location,
      details: party.details,
      rsvp_by: party.rsvp_by,
    }),
    guest: { name: guest.name, party_size_max: guest.party_size_max },
    rsvp: strip({
      status: state.status ?? "pending",
      party_size: state.party_size,
      dietary: state.dietary,
      note: state.note,
      by: state.by_kind ? { kind: state.by_kind, name: state.by_name } : undefined,
    }),
  };
  if (polls.length) {
    doc.polls = polls.map((p) => {
      const a = answers.find((x) => x.poll_id === p.id);
      if (p.kind === "date_rank") {
        return strip({ id: p.id, kind: p.kind, q: p.question, options: p.options, labels: p.options.map((o) => fmtDate(o, party.timezone)), closes_at: p.closes_at, your_ranking: a?.ranking });
      }
      return strip({ id: p.id, kind: p.kind, q: p.question, options: p.options, closes_at: p.closes_at, your_answer: a?.choice });
    });
  }
  if (lockedPolls) doc.polls_after_yes = lockedPolls;
  doc.actions = {
    rsvp: `POST ${base}/rsvp`,
    ...(polls.length ? { answer_poll: `POST ${base}/polls/{id}` } : {}),
    message_host: `POST ${base}/message`,
    calendar: `GET ${base}.ics`,
  };
  doc.schema = {
    rsvp: { status: "yes|no|maybe|needs_human", party_size: `int<=${guest.party_size_max}`, dietary: "string[]", note: "string", by: { kind: "agent|human", name: "string" } },
    answer_poll: { choice: "one of options (choice polls)", ranking: "options best-first, omit dates you can't make (date_rank polls)", note: "string", by: "same" },
    message_host: { text: "string", by: "same" },
  };
  return doc;
}

export function inviteText(ctx: InviteCtx, token: string): string {
  const { party, guest, state, polls, lockedPolls } = ctx;
  const base = `${siteUrl()}/i/${token}`;
  const when = fmtWhen(party);
  const lines = [
    `IndbyAgent invite v${SPEC_VERSION}`,
    `${guest.name}, you're invited to ${party.title}.`,
    `When: ${when}`,
    party.location ? `Where: ${party.location}` : null,
    party.details ? `Details: ${party.details}` : null,
    party.rsvp_by ? `RSVP by: ${party.rsvp_by}` : null,
    `Your RSVP: ${state.status ?? "pending"}${state.party_size ? ` (${state.party_size})` : ""}. Max party size: ${guest.party_size_max}.`,
    "",
    "To answer as an agent (replace values):",
    `curl -s ${base}.json`,
    `curl -s -X POST ${base}/rsvp -H 'content-type: application/json' \\`,
    `  -d '{"status":"yes","party_size":1,"dietary":[],"note":"","by":{"kind":"agent","name":"YOUR_AGENT"}}'`,
  ];
  for (const p of polls) {
    if (p.kind === "date_rank") {
      lines.push(`Date poll ${p.id} (ranked, best first; leave out dates you can't make): ${p.question}`);
      p.options.forEach((o) => lines.push(`  ${o} = ${fmtDate(o, party.timezone)}`));
      lines.push(`curl -s -X POST ${base}/polls/${p.id} -H 'content-type: application/json' -d '{"ranking":${JSON.stringify(p.options)},"by":{"kind":"agent","name":"YOUR_AGENT"}}'`);
      continue;
    }
    lines.push(`Poll ${p.id}: ${p.question} [${p.options.join(" | ")}]`);
    lines.push(`curl -s -X POST ${base}/polls/${p.id} -H 'content-type: application/json' -d '{"choice":"${p.options[0]}","by":{"kind":"agent","name":"YOUR_AGENT"}}'`);
  }
  if (lockedPolls) lines.push(`The host has ${lockedPolls} more poll(s), shown after you RSVP yes.`);
  lines.push(`Ask the host: curl -s -X POST ${base}/message -H 'content-type: application/json' -d '{"text":"...","by":{"kind":"agent","name":"YOUR_AGENT"}}'`);
  lines.push("Rules: status must be yes|no|maybe|needs_human. choice and ranking entries must match options exactly. GET never changes anything.");
  return lines.filter((l) => l !== null).join("\n") + "\n";
}

export function inviteIcs(ctx: InviteCtx, token: string): string {
  const { party, guest } = ctx;
  const dt = (s: string) => new Date(s).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const end = party.ends_at ?? new Date(new Date(party.starts_at).getTime() + 2 * 3600e3).toISOString();
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//IndbyAgent//EN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${guest.id}@indbyagent.com`,
    `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(party.starts_at)}`,
    `DTEND:${dt(end)}`,
    `SUMMARY:${esc(party.title)}`,
    party.location ? `LOCATION:${esc(party.location)}` : null,
    `DESCRIPTION:${esc((party.details ?? "") + `\nInvite: ${siteUrl()}/i/${token}`)}`,
    `URL:${siteUrl()}/i/${token}`,
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n") + "\r\n";
}

export function fmtDate(iso: string, timeZone: string): string {
  const o: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" };
  return new Intl.DateTimeFormat("en-US", o).format(new Date(iso));
}

export function fmtWhen(party: Party): string {
  const s = fmtDate(party.starts_at, party.timezone);
  if (!party.ends_at) return s;
  const e = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: party.timezone }).format(new Date(party.ends_at));
  return `${s} – ${e}`;
}

// ---------- writes ----------

const By = z.object({ kind: z.enum(["agent", "human"]), name: z.string().trim().max(80).optional() }).optional();
export const RsvpBody = z.object({
  status: z.enum(["yes", "no", "maybe", "needs_human"]),
  party_size: z.number().int().min(0).max(20).optional(),
  dietary: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  note: z.string().trim().max(500).optional(),
  by: By,
}).strict();
export const PollBody = z.object({
  choice: z.string().trim().min(1).max(100).optional(),
  ranking: z.array(z.string().trim().min(1).max(100)).min(1).max(8).optional(),
  note: z.string().trim().max(300).optional(),
  by: By,
}).strict().refine((b) => b.choice || b.ranking, { message: "send choice (choice polls) or ranking (date polls)" });
export const MessageBody = z.object({ text: z.string().trim().min(1).max(1000), by: By }).strict();

type WriteMeta = { channel: Channel; idempotency_key?: string | null; defaultKind?: ByKind };

export async function writeRsvp(ctx: InviteCtx, body: z.infer<typeof RsvpBody>, meta: WriteMeta) {
  const size = body.party_size ?? (body.status === "yes" ? 1 : 0);
  if (size > ctx.guest.party_size_max) return { error: `party_size exceeds max of ${ctx.guest.party_size_max}` };
  const { error } = await db.from("rsvps").insert({
    guest_id: ctx.guest.id, status: body.status, party_size: size, dietary: body.dietary ?? [], note: body.note ?? null,
    by_kind: body.by?.kind ?? meta.defaultKind ?? "human", by_name: body.by?.name ?? null, channel: meta.channel,
    idempotency_key: meta.idempotency_key ?? null,
  });
  if (error && error.code !== "23505") return { error: error.message };
  return { ok: true };
}

export async function writePollAnswer(ctx: InviteCtx, pollId: string, body: z.infer<typeof PollBody>, meta: WriteMeta) {
  const poll = ctx.polls.find((p) => p.id === pollId);
  if (!poll) return { error: "poll not open for this guest (RSVP yes first, and check the id)" };
  if (poll.kind === "date_rank") {
    if (!body.ranking) return { error: `this is a ranked date poll: send ranking, best first, from: ${poll.options.join(", ")}` };
    // Accept any spelling of the same instant, store the canonical option.
    const match = (r: string) => poll.options.find((o) => o === r || new Date(o).getTime() === new Date(r).getTime());
    const ranking = body.ranking.map(match).filter((o): o is string => !!o);
    if (ranking.length !== body.ranking.length) return { error: `ranking entries must be from: ${poll.options.join(", ")}` };
    if (new Set(ranking).size !== ranking.length) return { error: "ranking lists a date twice" };
    await store.saveRanking({ poll_id: poll.id, guest_id: ctx.guest.id, ranking, by_kind: body.by?.kind ?? meta.defaultKind ?? "human", by_name: body.by?.name ?? null, channel: meta.channel });
    return { ok: true };
  }
  if (!body.choice) return { error: `choice must be one of: ${poll.options.join(", ")}` };
  const choice = poll.options.find((o) => o.toLowerCase() === body.choice!.toLowerCase());
  if (!choice) return { error: `choice must be one of: ${poll.options.join(", ")}` };
  const { error } = await db.from("poll_answers").insert({
    poll_id: poll.id, guest_id: ctx.guest.id, choice, note: body.note ?? null,
    by_kind: body.by?.kind ?? meta.defaultKind ?? "human", by_name: body.by?.name ?? null, channel: meta.channel,
    idempotency_key: meta.idempotency_key ?? null,
  });
  if (error && error.code !== "23505") return { error: error.message };
  return { ok: true };
}

export async function writeMessage(ctx: InviteCtx, body: z.infer<typeof MessageBody>, meta: WriteMeta) {
  const { error } = await db.from("messages").insert({
    party_id: ctx.party.id, guest_id: ctx.guest.id, direction: "in", text: body.text,
    by_kind: body.by?.kind ?? meta.defaultKind ?? "human", by_name: body.by?.name ?? null, channel: meta.channel,
  });
  if (error) return { error: error.message };
  return { ok: true };
}
