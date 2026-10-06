-- Meet: an agent-readable introduction. One person (the card owner) carries a
-- QR; the other scans it and drops an address their agent reads. The owner's
-- agent then writes the first follow-up, human-readable with a machine block.
-- host_id is a Supabase hosts.id (no cross-database FK).

create table if not exists meet_cards (
  id uuid primary key,
  host_id uuid not null,
  slug text unique not null,                 -- /m/<slug>
  display_name text not null,
  headline text,                             -- one line: what you're building
  blurb text,                                -- 2-3 sentences for the page
  links jsonb not null default '{}'::jsonb,  -- {linkedin, site, calendar, github}
  inbox_address text,                        -- AgentMail inbox the owner's agent writes from
  reply_to text,                             -- human email for replies
  agent_url text,                            -- the owner's own agent endpoint, if any
  created_at timestamptz not null default now()
);

-- Where the QR was shown. The QR carries ?c=<code> so the page already knows
-- the room; the owner never types where they met someone.
create table if not exists meet_contexts (
  id uuid primary key,
  card_id uuid not null references meet_cards(id) on delete cascade,
  code text not null,
  label text not null,                       -- "a16z speedrun AI Faire, Fri Oct 9"
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  unique (card_id, code)
);

create table if not exists meets (
  id uuid primary key,
  card_id uuid not null references meet_cards(id) on delete cascade,
  context_id uuid references meet_contexts(id) on delete set null,
  context_label text,                        -- denormalised at drop time
  name text,
  agent_address text not null,               -- email or https:// endpoint their agent reads
  email text,                                -- human email if different
  note text,                                 -- what we talked about, in their words
  scopes text[] not null default '{}',       -- follow_up | schedule | share_deck | intro
  wants text,                                -- what they want from the owner
  status text not null default 'dropped' check (status in ('dropped','sent','replied','scheduled','closed')),
  intro_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  replied_at timestamptz
);
create index if not exists meets_card_idx on meets (card_id, created_at desc);
