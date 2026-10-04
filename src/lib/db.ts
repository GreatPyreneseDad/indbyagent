import { createClient } from "@supabase/supabase-js";

// Service-role client for server code only. Guest access is authorized by the
// per-guest token (checked in code), host access by HOST_SECRET. Never import
// this from a client component.
export const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export type RsvpStatus = "pending" | "yes" | "no" | "maybe" | "needs_human";
export type ByKind = "agent" | "human" | "host";
export type Channel = "api" | "web" | "email" | "sms";

export type Party = {
  id: string; host_id: string; slug: string; title: string; kind: string | null;
  starts_at: string; ends_at: string | null; timezone: string; location: string | null;
  details: string | null; rsvp_by: string | null; inbox_address: string | null;
  planning: Record<string, string>;
};
export type Guest = {
  id: string; party_id: string; name: string; email: string | null; phone: string | null;
  party_size_max: number; token_hash: string; token_revoked_at: string | null;
};
export type GuestState = {
  guest_id: string; party_id: string; name: string; email: string | null; party_size_max: number;
  status: RsvpStatus | null; party_size: number | null; dietary: string[] | null; note: string | null;
  by_kind: ByKind | null; by_name: string | null; channel: Channel | null; answered_at: string | null;
};
export type PollKind = "choice" | "date_rank";
export type Poll = { id: string; party_id: string; question: string; options: string[]; closes_at: string | null; status: "open" | "closed"; kind: PollKind; created_by: "host" | "agent" };
export type PollAnswer = { poll_id: string; guest_id: string; choice: string; ranking: string[] | null; note: string | null; by_kind: ByKind; by_name: string | null; channel: Channel; created_at: string };
export type PlanningMessage = { id: string; party_id: string; role: "user" | "assistant"; text: string; created_at: string };
