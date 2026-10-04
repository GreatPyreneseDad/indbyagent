import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "./db";
import { hashToken, newToken, inviteUrl, safeEqual } from "./token";

// Hackathon auth: one shared host secret (cookie or bearer). Replace with
// Supabase Auth later; the schema already has hosts.auth_user_id for it.
export function hostAuthed(req: NextRequest): boolean {
  const s = process.env.HOST_SECRET;
  if (!s) return false;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const cookie = req.cookies.get("host")?.value;
  return !!((bearer && safeEqual(bearer, s)) || (cookie && safeEqual(cookie, s)));
}
export const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

export async function defaultHost() {
  const { data } = await db.from("hosts").select("*").order("created_at").limit(1).maybeSingle();
  if (data) return data;
  const { data: h } = await db.from("hosts").insert({ name: "Host" }).select().single();
  return h!;
}

export const PartyBody = z.object({
  title: z.string().trim().min(1).max(120),
  kind: z.string().trim().max(40).optional(),
  starts_at: z.string().datetime({ offset: true }),
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
  question: z.string().trim().min(1).max(200),
  options: z.array(z.string().trim().min(1).max(60)).min(2).max(8),
  closes_at: z.string().datetime({ offset: true }).optional(),
});

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
