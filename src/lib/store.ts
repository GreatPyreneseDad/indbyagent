import { randomUUID } from "node:crypto";
import type { ByKind, Channel, Poll } from "./db";

// Storage for the planning chat and ranked date polls. These features add no
// tables or columns: everything lives in this process's memory and is gone on
// restart (and not shared across serverless instances). To persist it, swap
// `store` for an implementation of FeatureStore backed by the database.

export type PlanningMessage = { id: string; party_id: string; role: "user" | "assistant"; text: string; created_at: string };
export type DatePoll = Poll & { kind: "date_rank" };
export type DateRanking = { poll_id: string; guest_id: string; ranking: string[]; by_kind: ByKind; by_name: string | null; channel: Channel; created_at: string };

export interface FeatureStore {
  planningMessages(partyId: string): Promise<PlanningMessage[]>;
  addPlanningMessage(partyId: string, role: PlanningMessage["role"], text: string): Promise<PlanningMessage>;
  planningNotes(partyId: string): Promise<Record<string, string>>;
  setPlanningNotes(partyId: string, notes: Record<string, string>): Promise<void>;
  datePoll(partyId: string): Promise<DatePoll | null>;
  createDatePoll(partyId: string, question: string, options: string[]): Promise<DatePoll>;
  rankings(pollId: string): Promise<DateRanking[]>;
  saveRanking(r: Omit<DateRanking, "created_at">): Promise<void>;
}

type Mem = {
  messages: Map<string, PlanningMessage[]>;
  notes: Map<string, Record<string, string>>;
  datePolls: Map<string, DatePoll>;
  rankings: Map<string, Map<string, DateRanking>>;
};

// Kept on globalThis so Next.js dev reloads don't wipe it.
const g = globalThis as typeof globalThis & { __indbyagentStore?: Mem };
const mem: Mem = (g.__indbyagentStore ??= { messages: new Map(), notes: new Map(), datePolls: new Map(), rankings: new Map() });

export const memoryStore: FeatureStore = {
  async planningMessages(partyId) { return [...(mem.messages.get(partyId) ?? [])]; },
  async addPlanningMessage(partyId, role, text) {
    const m: PlanningMessage = { id: randomUUID(), party_id: partyId, role, text, created_at: new Date().toISOString() };
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
    byGuest.set(r.guest_id, { ...r, created_at: new Date().toISOString() });
    mem.rankings.set(r.poll_id, byGuest);
  },
};

export const store: FeatureStore = memoryStore;
