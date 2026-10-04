import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "./db";
import { hashToken, newToken, inviteUrl } from "./token";

export const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
export const forbidden = () => NextResponse.json({ error: "not your party" }, { status: 403 });

export const PartyBody = z.object({
  title: z.string().trim().min(1).max(120),
  kind: z.string().trim().max(40).optional(),
  starts_at: z.string().datetime({ offset: true }).optional(), // omit it and open a "dates" poll
  ends_at: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().default("America/Los_Angeles"),
  location: z.string().trim().max(200).optional(),
  details: z.string().trim().max(1000).optional(),
  rsvp_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export const GuestsBody = z.object({
  guests: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    email: z.string().email().optional(),
    party_size_max: z.number().int().min(1).max(20).default(1),
  })).min(1).max(200),
});
export const PollCreateBody = z.object({
  kind: z.enum(["preference", "dates"]).default("preference"),
  question: z.string().trim().min(1).max(200).optional(),
  options: z.array(z.string().trim().min(1).max(60)).min(2).max(8),
  closes_at: z.string().datetime({ offset: true }).optional(),
}).superRefine((v, ctx) => {
  if (v.kind === "dates") {
    for (const o of v.options) if (isNaN(Date.parse(o)) || !/^\d{4}-\d{2}-\d{2}/.test(o)) ctx.addIssue({ code: "custom", path: ["options"], message: `dates poll options must be ISO-8601 datetimes, got "${o}"` });
  } else if (!v.question) ctx.addIssue({ code: "custom", path: ["question"], message: "question is required" });
});
export const PollPatchBody = z.object({
  status: z.enum(["open", "closed"]).optional(),
  set_date: z.boolean().optional(), // dates poll: write the winner to parties.starts_at
}).strict();

// Ranked-choice tally (Borda). Each guest's ranking gives n-1 points to their
// first choice, n-2 to the second, ... Unranked options get 0. A plain `choice`
// counts as a one-item ranking.
export function tallyRanked(options: string[], answers: { ranking?: string[] | null; choice?: string | null }[]) {
  const n = options.length;
  const score: Record<string, number> = Object.fromEntries(options.map((o) => [o, 0]));
  const firsts: Record<string, number> = Object.fromEntries(options.map((o) => [o, 0]));
  for (const a of answers) {
    const r = (a.ranking?.length ? a.ranking : a.choice ? [a.choice] : []).filter((o) => o in score);
    r.forEach((o, i) => { score[o] += n - 1 - i; });
    if (r[0]) firsts[r[0]] += 1;
  }
  const ranked = [...options].sort((a, b) => score[b] - score[a] || firsts[b] - firsts[a] || options.indexOf(a) - options.indexOf(b));
  return { score, firsts, winner: answers.length ? ranked[0] : null, ranked };
}

export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) + "-" + Math.random().toString(36).slice(2, 6);
}

export async function createGuests(partyId: string, guests: { name: string; email?: string; party_size_max?: number }[]) {
  const rows = guests.map((g) => ({ token: newToken(), g }));
  const { data, error } = await db.from("guests").insert(rows.map(({ token, g }) => ({
    party_id: partyId, name: g.name, email: g.email ?? null, party_size_max: g.party_size_max ?? 1, token_hash: hashToken(token),
  }))).select("id,name,email");
  if (error) throw new Error(error.message);
  // Tokens are returned exactly once, here. They are never stored in clear.
  return data!.map((row, i) => ({ ...row, token: rows[i].token, invite_url: inviteUrl(rows[i].token) }));
}
