-- Planning chat between the host and Claude, per party.
create table planning_messages (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  text text not null,
  created_at timestamptz not null default now()
);
create index planning_messages_party_idx on planning_messages(party_id, created_at);

create table planning_notes (
  party_id uuid primary key references parties(id) on delete cascade,
  notes jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table planning_messages enable row level security;
alter table planning_notes enable row level security;
