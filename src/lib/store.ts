import { db } from "./db";

// Planning chat storage: two small tables (planning_messages, planning_notes).
// In local test mode (lib/fallback.ts) `db` is the in-memory stand-in, so this
// works without Supabase too.

export type PlanningMessage = { id: string; party_id: string; role: "user" | "assistant"; text: string; created_at: string };

export const store = {
  async planningMessages(partyId: string): Promise<PlanningMessage[]> {
    const { data } = await db.from("planning_messages").select("*").eq("party_id", partyId).order("created_at").limit(200);
    return (data ?? []) as PlanningMessage[];
  },
  async addPlanningMessage(partyId: string, role: PlanningMessage["role"], text: string): Promise<void> {
    await db.from("planning_messages").insert({ party_id: partyId, role, text: text.slice(0, 4000) });
  },
  async planningNotes(partyId: string): Promise<Record<string, string>> {
    const { data } = await db.from("planning_notes").select("notes").eq("party_id", partyId).maybeSingle();
    return { ...((data?.notes as Record<string, string> | null) ?? {}) };
  },
  async setPlanningNotes(partyId: string, notes: Record<string, string>): Promise<void> {
    await db.from("planning_notes").upsert({ party_id: partyId, notes, updated_at: new Date().toISOString() });
  },
};
