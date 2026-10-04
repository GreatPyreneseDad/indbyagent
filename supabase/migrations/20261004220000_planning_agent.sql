-- 2026-10-04: planning chat between the host and Claude, per party.
-- What the agent learns is saved on the party as topic -> value.
alter table parties add column planning jsonb not null default '{}'::jsonb;

create table planning_messages (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  text text not null,
  created_at timestamptz not null default now()
);
create index planning_messages_party_idx on planning_messages(party_id, created_at);

alter table planning_messages enable row level security;
create policy host_planning on planning_messages for all using (party_id in (select id from parties where host_id in (select id from hosts where auth_user_id = auth.uid())));

-- Polls: who made it, and ranked-choice date polls.
-- A date_rank poll's options are ISO timestamps; an answer's ranking lists
-- options best-first and choice holds the top pick.
alter table polls add column created_by text not null default 'host' check (created_by in ('host','agent'));
alter table polls add column kind text not null default 'choice' check (kind in ('choice','date_rank'));
alter table poll_answers add column ranking text[];

create or replace view poll_state with (security_invoker = true) as
select p.id as poll_id, p.party_id, p.question, p.options, p.status, p.closes_at,
       a.guest_id, a.choice, a.note, a.by_kind, a.by_name, a.channel, a.created_at as answered_at,
       p.kind, a.ranking
from polls p
left join lateral (
  select distinct on (guest_id) * from poll_answers where poll_id = p.id order by guest_id, created_at desc
) a on true;
