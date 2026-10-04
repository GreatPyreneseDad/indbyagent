-- IndbyAgent core schema v0.1
create extension if not exists pgcrypto;

create type rsvp_status as enum ('pending','yes','no','maybe','needs_human');
create type by_kind as enum ('agent','human','host');
create type channel as enum ('api','web','email','sms');
create type poll_status as enum ('open','closed');

create table hosts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  name text not null,
  email text,
  created_at timestamptz not null default now()
);

create table parties (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references hosts(id) on delete cascade,
  slug text unique not null,
  title text not null,
  kind text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  timezone text not null default 'America/Los_Angeles',
  location text,
  details text,
  rsvp_by date,
  inbox_address text,
  created_at timestamptz not null default now()
);

create table guests (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  party_size_max int not null default 1 check (party_size_max between 1 and 20),
  token_hash text unique not null,
  token_revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index guests_party_idx on guests(party_id);

create table rsvps (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references guests(id) on delete cascade,
  status rsvp_status not null,
  party_size int check (party_size between 0 and 20),
  dietary text[] not null default '{}',
  note text,
  by_kind by_kind not null,
  by_name text,
  channel channel not null,
  idempotency_key text,
  created_at timestamptz not null default now()
);
create index rsvps_guest_created_idx on rsvps(guest_id, created_at desc);
create unique index rsvps_idem_idx on rsvps(guest_id, idempotency_key) where idempotency_key is not null;

create table polls (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  question text not null,
  options text[] not null check (array_length(options,1) between 2 and 8),
  closes_at timestamptz,
  status poll_status not null default 'open',
  created_at timestamptz not null default now()
);
create index polls_party_idx on polls(party_id);

create table poll_answers (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  guest_id uuid not null references guests(id) on delete cascade,
  choice text not null,
  note text,
  by_kind by_kind not null,
  by_name text,
  channel channel not null,
  idempotency_key text,
  created_at timestamptz not null default now()
);
create index poll_answers_poll_idx on poll_answers(poll_id, created_at desc);
create unique index poll_answers_idem_idx on poll_answers(poll_id, guest_id, idempotency_key) where idempotency_key is not null;

create table messages (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  guest_id uuid references guests(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  text text not null,
  by_kind by_kind not null,
  by_name text,
  channel channel not null,
  created_at timestamptz not null default now()
);
create index messages_party_idx on messages(party_id, created_at desc);

create table review_queue (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  guest_id uuid references guests(id) on delete set null,
  raw_text text not null,
  parse jsonb,
  reason text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table llm_calls (
  id uuid primary key default gen_random_uuid(),
  party_id uuid references parties(id) on delete set null,
  purpose text not null,
  model text not null,
  effort text,
  input_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  output_tokens int not null default 0,
  ms int,
  created_at timestamptz not null default now()
);

-- Current-state views (latest row wins)
create view guest_state with (security_invoker = true) as
select g.id as guest_id, g.party_id, g.name, g.email, g.party_size_max,
       r.status, r.party_size, r.dietary, r.note, r.by_kind, r.by_name, r.channel, r.created_at as answered_at
from guests g
left join lateral (
  select * from rsvps where guest_id = g.id order by created_at desc limit 1
) r on true;

create view poll_state with (security_invoker = true) as
select p.id as poll_id, p.party_id, p.question, p.options, p.status, p.closes_at,
       a.guest_id, a.choice, a.note, a.by_kind, a.by_name, a.channel, a.created_at as answered_at
from polls p
left join lateral (
  select distinct on (guest_id) * from poll_answers where poll_id = p.id order by guest_id, created_at desc
) a on true;

-- RLS: everything locked. Guest routes use the service role with token checks in app code;
-- host routes use auth.uid() -> hosts.auth_user_id.
alter table hosts enable row level security;
alter table parties enable row level security;
alter table guests enable row level security;
alter table rsvps enable row level security;
alter table polls enable row level security;
alter table poll_answers enable row level security;
alter table messages enable row level security;
alter table review_queue enable row level security;
alter table llm_calls enable row level security;

create policy host_self on hosts for all using (auth_user_id = auth.uid());
create policy host_parties on parties for all using (host_id in (select id from hosts where auth_user_id = auth.uid()));
create policy host_guests on guests for all using (party_id in (select id from parties where host_id in (select id from hosts where auth_user_id = auth.uid())));
create policy host_rsvps on rsvps for select using (guest_id in (select id from guests where party_id in (select id from parties where host_id in (select id from hosts where auth_user_id = auth.uid()))));
create policy host_polls on polls for all using (party_id in (select id from parties where host_id in (select id from hosts where auth_user_id = auth.uid())));
create policy host_poll_answers on poll_answers for select using (poll_id in (select id from polls where party_id in (select id from parties where host_id in (select id from hosts where auth_user_id = auth.uid()))));
create policy host_messages on messages for all using (party_id in (select id from parties where host_id in (select id from hosts where auth_user_id = auth.uid())));
create policy host_review on review_queue for all using (party_id in (select id from parties where host_id in (select id from hosts where auth_user_id = auth.uid())));
create policy host_llm on llm_calls for select using (party_id in (select id from parties where host_id in (select id from hosts where auth_user_id = auth.uid())));

-- Realtime for the host board
alter publication supabase_realtime add table rsvps, poll_answers, messages, guests;
