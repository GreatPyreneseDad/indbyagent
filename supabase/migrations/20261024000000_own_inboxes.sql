-- A subscriber's own AgentMail account (signed up through AgentMail's agent
-- sign-up API in the subscriber's name, verified by the code AgentMail emails
-- them). Keyed by the host's email so every party of that host can use it.
-- The API key is stored encrypted (AES-256-GCM, key in MAIL_KEY_SECRET).
create table if not exists mail_accounts (
  email text primary key,
  org_id text not null,
  inbox_id text not null unique,
  api_key_enc text not null,
  status text not null default 'pending' check (status in ('pending', 'verified')),
  webhook_id text,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);
alter table mail_accounts enable row level security;

-- Which hosts may send from an account. The host that verified it is linked;
-- other hosts (an agent's later events) link with the inbox token returned at
-- verification, or by signing in with the same email.
alter table mail_accounts add column if not exists inbox_token_hash text unique;
create table if not exists mail_account_hosts (
  host_id uuid primary key references hosts(id) on delete cascade,
  email text not null references mail_accounts(email) on delete cascade,
  linked_at timestamptz not null default now()
);
alter table mail_account_hosts enable row level security;
