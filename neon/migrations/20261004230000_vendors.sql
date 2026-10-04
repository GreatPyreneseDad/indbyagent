-- Neon (separate from Supabase): venue and vendor suggestions from the venue agent.
-- party_id and host_id are ids from the Supabase database, so no foreign keys.
-- Access is authorized in app code (currentHost + hostOwnsParty) before any query.
create table if not exists venue_suggestions (
  id uuid primary key,
  party_id uuid not null,
  host_id uuid not null,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  target_time timestamptz not null,
  venue jsonb not null,
  availability jsonb not null,
  invitees jsonb not null,
  vendors jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  mock boolean not null default false,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists venue_suggestions_party_idx on venue_suggestions (party_id, created_at desc);
create unique index if not exists venue_suggestions_one_confirmed on venue_suggestions (party_id) where status = 'confirmed';
