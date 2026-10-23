-- Agent-created parties (the Agensi skill). Each gets its own hosts row and a
-- host token scoped to that one party, stored hashed. A separate board token
-- opens a read-only board page (/b/<token>) the host can keep in a browser.
alter table parties add column if not exists host_token_hash text unique;
alter table parties add column if not exists board_token_hash text unique;
alter table parties add column if not exists created_via text not null default 'web';
alter table parties add column if not exists created_ip text;
create index if not exists parties_created_ip_idx on parties(created_ip, created_at desc);
