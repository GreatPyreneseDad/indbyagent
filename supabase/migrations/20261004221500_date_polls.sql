-- Date polls: a party can start with no date; a ranked "dates" poll picks one.
alter table parties alter column starts_at drop not null;

alter table polls add column kind text not null default 'preference'
  check (kind in ('preference', 'dates'));
-- For kind='dates', options are ISO-8601 datetimes (with offset).

alter table poll_answers add column ranking text[];
-- For ranked answers: full or partial ordering of options, best first.
-- choice always holds ranking[1] so single-choice readers keep working.

create or replace view poll_state with (security_invoker = true) as
select p.id as poll_id, p.party_id, p.question, p.options, p.status, p.closes_at,
       a.guest_id, a.choice, a.note, a.by_kind, a.by_name, a.channel, a.created_at as answered_at,
       p.kind, a.ranking
from polls p
left join lateral (
  select distinct on (guest_id) * from poll_answers where poll_id = p.id order by guest_id, created_at desc
) a on true;
