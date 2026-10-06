-- The card owner's agent gets a brief (who the owner is, what they want from
-- meetings, how to talk) and a conversation log per meet.

alter table meet_cards add column if not exists agent_brief text;
alter table meet_cards add column if not exists agent_model text not null default 'claude-sonnet-5-5';

alter table meets drop constraint if exists meets_status_check;
alter table meets add constraint meets_status_check check (status in ('dropped','sent','replied','scheduled','needs_human','closed','stopped'));
alter table meets add column if not exists summary text;        -- the agent's running one-paragraph summary
alter table meets add column if not exists proposed_times jsonb;  -- last times proposed, ISO strings

create table if not exists meet_messages (
  id uuid primary key,
  meet_id uuid not null references meets(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  by_kind text not null default 'human' check (by_kind in ('human','agent','system')),
  text text not null,
  message_id text,
  action text,                      -- for 'out': continue | propose_times | confirm_time | escalate | stop
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists meet_messages_meet_idx on meet_messages (meet_id, created_at);
