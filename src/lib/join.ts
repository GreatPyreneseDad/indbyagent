import { z } from "zod";
import { db, type Party } from "./db";
import { hashToken, newToken, looksLikeToken, inviteUrl, siteUrl } from "./token";
import { createGuests } from "./host";

export async function loadJoin(code: string): Promise<Party | null> {
  if (!looksLikeToken(code)) return null;
  const { data } = await db.from("parties").select("*").eq("join_token_hash", hashToken(code)).maybeSingle();
  if (!data || !data.join_enabled) return null;
  return data as Party;
}

export async function ensureJoinCode(party: Party): Promise<string> {
  // Codes are hashed at rest, so an existing one can't be read back; the host
  // gets a fresh code (old QR keeps working only until the next rotation).
  const code = newToken();
  await db.from("parties").update({ join_token_hash: hashToken(code) }).eq("id", party.id);
  return code;
}

export const JoinBody = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().optional().or(z.literal("")),
  party_size_max: z.number().int().min(1).max(6).optional(),
  by: z.object({ kind: z.enum(["agent", "human"]), name: z.string().trim().max(80).optional() }).optional(),
}).strict();

export async function joinParty(party: Party, body: z.infer<typeof JoinBody>) {
  const { count } = await db.from("guests").select("id", { count: "exact", head: true }).eq("party_id", party.id);
  if ((count ?? 0) >= (party as Party & { join_max?: number }).join_max!) return { error: "this party is full" };
  const [g] = await createGuests(party.id, [{ name: body.name, email: body.email || undefined, party_size_max: body.party_size_max ?? 2 }]);
  await db.from("guests").update({ self_joined: true }).eq("id", g.id);
  return { ok: true, guest: { name: g.name }, invite_url: g.invite_url, invite_json: `${g.invite_url}.json`, token: g.token };
}

export async function joinStats(party: Party) {
  const [{ data: g }, { data: polls }] = await Promise.all([
    db.from("guest_state").select("status,by_kind,party_size").eq("party_id", party.id),
    db.from("polls").select("id,question,options").eq("party_id", party.id).eq("status", "open").order("created_at", { ascending: false }).limit(1),
  ]);
  const rows = g ?? [];
  const out: Record<string, unknown> = {
    party: { title: party.title, starts_at: party.starts_at, location: party.location },
    joined: rows.length,
    yes: rows.filter((r) => r.status === "yes").length,
    headcount: rows.filter((r) => r.status === "yes").reduce((a, r) => a + (r.party_size ?? 1), 0),
    by_agent: rows.filter((r) => r.by_kind === "agent").length,
    by_human: rows.filter((r) => r.by_kind === "human").length,
  };
  if (polls?.[0]) {
    const { data: a } = await db.from("poll_state").select("choice").eq("poll_id", polls[0].id);
    const counts: Record<string, number> = Object.fromEntries(polls[0].options.map((o: string) => [o, 0]));
    for (const r of a ?? []) if (r.choice) counts[r.choice] = (counts[r.choice] ?? 0) + 1;
    out.poll = { question: polls[0].question, counts };
  }
  return out;
}

export const joinUrl = (code: string) => `${siteUrl()}/j/${code}`;
export const screenUrl = (code: string) => `${siteUrl()}/q/${code}`;
export { inviteUrl };
