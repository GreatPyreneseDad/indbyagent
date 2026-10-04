import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { ByKind, Channel, Poll } from "./db";

// Storage for agent features: the planning chat, ranked date polls and venue
// suggestions. It never touches the app's main (Supabase) database. With
// AGENT_DATABASE_URL set it uses that separate Postgres (Neon); otherwise it
// keeps everything in this process's memory, which is lost on restart and not
// shared across serverless instances.

export type PlanningMessage = { id: string; party_id: string; role: "user" | "assistant"; text: string; created_at: string };
export type DatePoll = Poll & { kind: "date_rank" };
export type DateRanking = { poll_id: string; guest_id: string; ranking: string[]; by_kind: ByKind; by_name: string | null; channel: Channel; created_at: string };

export type VenueStatus = "pending" | "confirmed" | "rejected";
export type VenueSuggestion = {
  id: string; party_id: string; status: VenueStatus; created_at: string; decided_at: string | null;
  target_time: string;
  venue: { name: string; address: string; url: string | null; why: string; capacity_fit: string; est_cost: string | null };
  // From published hours and booking info. "open" is not a confirmed booking.
  availability: { status: "open" | "closed" | "unknown"; evidence: string; booking_url: string | null };
  invitees: { available: string[]; unavailable: string[]; unknown: string[] };
  vendors: { category: string; name: string; url: string | null; why: string }[];
  sources: string[];
  mock: boolean;
};
export type NewVenueSuggestion = Omit<VenueSuggestion, "id" | "status" | "created_at" | "decided_at">;

export interface FeatureStore {
  planningMessages(partyId: string): Promise<PlanningMessage[]>;
  addPlanningMessage(partyId: string, role: PlanningMessage["role"], text: string): Promise<PlanningMessage>;
  planningNotes(partyId: string): Promise<Record<string, string>>;
  setPlanningNotes(partyId: string, notes: Record<string, string>): Promise<void>;
  datePoll(partyId: string): Promise<DatePoll | null>;
  createDatePoll(partyId: string, question: string, options: string[]): Promise<DatePoll>;
  rankings(pollId: string): Promise<DateRanking[]>;
  saveRanking(r: Omit<DateRanking, "created_at">): Promise<void>;
  venueSuggestions(partyId: string): Promise<VenueSuggestion[]>;
  addVenueSuggestion(s: NewVenueSuggestion): Promise<VenueSuggestion>;
  decideVenue(partyId: string, id: string, status: Exclude<VenueStatus, "pending">): Promise<VenueSuggestion | null>;
}

const nowIso = () => new Date().toISOString();

// ---------- memory ----------

type Mem = {
  messages: Map<string, PlanningMessage[]>;
  notes: Map<string, Record<string, string>>;
  datePolls: Map<string, DatePoll>;
  rankings: Map<string, Map<string, DateRanking>>;
  venues: Map<string, VenueSuggestion[]>;
};

// Kept on globalThis so Next.js dev reloads don't wipe it.
const g = globalThis as typeof globalThis & { __indbyagentStore?: Mem };
const mem: Mem = (g.__indbyagentStore ??= { messages: new Map(), notes: new Map(), datePolls: new Map(), rankings: new Map(), venues: new Map() });
mem.venues ??= new Map();

export const memoryStore: FeatureStore = {
  async planningMessages(partyId) { return [...(mem.messages.get(partyId) ?? [])]; },
  async addPlanningMessage(partyId, role, text) {
    const m: PlanningMessage = { id: randomUUID(), party_id: partyId, role, text, created_at: nowIso() };
    mem.messages.set(partyId, [...(mem.messages.get(partyId) ?? []), m]);
    return m;
  },
  async planningNotes(partyId) { return { ...(mem.notes.get(partyId) ?? {}) }; },
  async setPlanningNotes(partyId, notes) { mem.notes.set(partyId, { ...notes }); },
  async datePoll(partyId) { return mem.datePolls.get(partyId) ?? null; },
  async createDatePoll(partyId, question, options) {
    const p: DatePoll = { id: randomUUID(), party_id: partyId, question, options, closes_at: null, status: "open", kind: "date_rank" };
    mem.datePolls.set(partyId, p);
    return p;
  },
  async rankings(pollId) { return [...(mem.rankings.get(pollId)?.values() ?? [])]; },
  async saveRanking(r) {
    const byGuest = mem.rankings.get(r.poll_id) ?? new Map<string, DateRanking>();
    byGuest.set(r.guest_id, { ...r, created_at: nowIso() });
    mem.rankings.set(r.poll_id, byGuest);
  },
  async venueSuggestions(partyId) { return [...(mem.venues.get(partyId) ?? [])].reverse(); },
  async addVenueSuggestion(s) {
    const v: VenueSuggestion = { ...s, id: randomUUID(), status: "pending", created_at: nowIso(), decided_at: null };
    mem.venues.set(s.party_id, [...(mem.venues.get(s.party_id) ?? []), v]);
    return v;
  },
  async decideVenue(partyId, id, status) {
    const v = (mem.venues.get(partyId) ?? []).find((x) => x.id === id);
    if (!v) return null;
    Object.assign(v, { status, decided_at: nowIso() });
    return { ...v };
  },
};

// ---------- Postgres (Neon) ----------

// party_id/guest_id refer to rows in the main database, so there are no
// foreign keys. Timestamps are ISO text so they round-trip unchanged.
const SCHEMA = [
  `create table if not exists planning_messages (id uuid primary key, party_id text not null, role text not null, text text not null, created_at text not null)`,
  `create index if not exists planning_messages_party_idx on planning_messages (party_id, created_at)`,
  `create table if not exists planning_notes (party_id text primary key, notes jsonb not null)`,
  `create table if not exists date_polls (id uuid primary key, party_id text unique not null, question text not null, options jsonb not null, created_at text not null)`,
  `create table if not exists date_rankings (poll_id uuid not null, guest_id text not null, ranking jsonb not null, by_kind text not null, by_name text, channel text not null, created_at text not null, primary key (poll_id, guest_id))`,
  `create table if not exists venue_suggestions (id uuid primary key, party_id text not null, status text not null, data jsonb not null, created_at text not null, decided_at text)`,
  `create index if not exists venue_suggestions_party_idx on venue_suggestions (party_id, created_at)`,
];

type VenueRow = { id: string; party_id: string; status: VenueStatus; data: NewVenueSuggestion; created_at: string; decided_at: string | null };
const venueFromRow = (r: VenueRow): VenueSuggestion => ({ ...r.data, id: r.id, party_id: r.party_id, status: r.status, created_at: r.created_at, decided_at: r.decided_at });

export function postgresStore(url: string): FeatureStore {
  const sql = neon(url);
  let ready: Promise<void> | null = null;
  const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> => {
    ready ??= (async () => { for (const s of SCHEMA) await sql.query(s); })().catch((e) => { ready = null; throw e; });
    await ready;
    return (await sql.query(text, params)) as T[];
  };
  return {
    async planningMessages(partyId) {
      return q<PlanningMessage>(`select id, party_id, role, text, created_at from planning_messages where party_id = $1 order by created_at, id`, [partyId]);
    },
    async addPlanningMessage(partyId, role, text) {
      const m: PlanningMessage = { id: randomUUID(), party_id: partyId, role, text, created_at: nowIso() };
      await q(`insert into planning_messages (id, party_id, role, text, created_at) values ($1, $2, $3, $4, $5)`, [m.id, partyId, role, text, m.created_at]);
      return m;
    },
    async planningNotes(partyId) {
      const [r] = await q<{ notes: Record<string, string> }>(`select notes from planning_notes where party_id = $1`, [partyId]);
      return r?.notes ?? {};
    },
    async setPlanningNotes(partyId, notes) {
      await q(`insert into planning_notes (party_id, notes) values ($1, $2) on conflict (party_id) do update set notes = excluded.notes`, [partyId, JSON.stringify(notes)]);
    },
    async datePoll(partyId) {
      const [r] = await q<{ id: string; party_id: string; question: string; options: string[] }>(`select id, party_id, question, options from date_polls where party_id = $1`, [partyId]);
      return r ? { ...r, closes_at: null, status: "open", kind: "date_rank" } : null;
    },
    async createDatePoll(partyId, question, options) {
      const p: DatePoll = { id: randomUUID(), party_id: partyId, question, options, closes_at: null, status: "open", kind: "date_rank" };
      await q(`insert into date_polls (id, party_id, question, options, created_at) values ($1, $2, $3, $4, $5)
        on conflict (party_id) do update set question = excluded.question, options = excluded.options`, [p.id, partyId, question, JSON.stringify(options), nowIso()]);
      return (await this.datePoll(partyId)) ?? p;
    },
    async rankings(pollId) {
      return q<DateRanking>(`select poll_id, guest_id, ranking, by_kind, by_name, channel, created_at from date_rankings where poll_id = $1`, [pollId]);
    },
    async saveRanking(r) {
      await q(`insert into date_rankings (poll_id, guest_id, ranking, by_kind, by_name, channel, created_at) values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (poll_id, guest_id) do update set ranking = excluded.ranking, by_kind = excluded.by_kind, by_name = excluded.by_name, channel = excluded.channel, created_at = excluded.created_at`,
      [r.poll_id, r.guest_id, JSON.stringify(r.ranking), r.by_kind, r.by_name, r.channel, nowIso()]);
    },
    async venueSuggestions(partyId) {
      return (await q<VenueRow>(`select id, party_id, status, data, created_at, decided_at from venue_suggestions where party_id = $1 order by created_at desc`, [partyId])).map(venueFromRow);
    },
    async addVenueSuggestion(s) {
      const id = randomUUID(), created_at = nowIso();
      await q(`insert into venue_suggestions (id, party_id, status, data, created_at) values ($1, $2, 'pending', $3, $4)`, [id, s.party_id, JSON.stringify(s), created_at]);
      return { ...s, id, status: "pending", created_at, decided_at: null };
    },
    async decideVenue(partyId, id, status) {
      const [r] = await q<VenueRow>(`update venue_suggestions set status = $3, decided_at = $4 where id = $2 and party_id = $1 returning id, party_id, status, data, created_at, decided_at`, [partyId, id, status, nowIso()]);
      return r ? venueFromRow(r) : null;
    },
  };
}

export const store: FeatureStore = process.env.AGENT_DATABASE_URL ? postgresStore(process.env.AGENT_DATABASE_URL) : memoryStore;
