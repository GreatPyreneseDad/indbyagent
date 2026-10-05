-- Vendor communications: a request for quote is a link a vendor (or its agent)
-- can read and answer, like an invite. Plus host-authorized payments.
-- party_id / host_id are Supabase ids (no cross-database FKs); routes check
-- currentHost + hostOwnsParty before any query here.

create table if not exists vendor_requests (
  id uuid primary key,
  party_id uuid not null,
  host_id uuid not null,
  suggestion_id uuid,                       -- venue_suggestions.id the vendor came from, if any
  vendor jsonb not null,                    -- {name, category, url, phone, email, address}
  need text not null,
  budget_line text,
  needed_by date,
  token_hash text unique not null,
  token_revoked_at timestamptz,
  status text not null default 'draft' check (status in ('draft','sent','quoted','declined','accepted','closed')),
  channel text,                             -- email | link | none
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  decided_at timestamptz
);
create index if not exists vendor_requests_party_idx on vendor_requests (party_id, created_at desc);
-- one accepted vendor per category per party
create unique index if not exists vendor_requests_one_accepted on vendor_requests (party_id, (vendor->>'category')) where status = 'accepted';

create table if not exists vendor_replies (
  id uuid primary key,
  request_id uuid not null references vendor_requests(id) on delete cascade,
  kind text not null check (kind in ('quote','message','decline')),
  price numeric,
  currency text default 'usd',
  available text check (available in ('yes','no','alternative')),
  alternative timestamptz,
  lead_time_days int,
  notes text,
  valid_until date,
  raw_text text,
  evidence text,
  confidence numeric,
  source text not null default 'api',       -- api | fast | llm
  by_kind text not null,
  by_name text,
  channel text not null,                    -- api | web | email
  idempotency_key text,
  created_at timestamptz not null default now()
);
create index if not exists vendor_replies_request_idx on vendor_replies (request_id, created_at desc);
create unique index if not exists vendor_replies_idem on vendor_replies (request_id, idempotency_key) where idempotency_key is not null;

-- A host's explicit, bounded permission for an agent to pay one vendor.
-- The agent can execute only inside the cap, before expiry, for an accepted
-- request. Payment method references are opaque provider tokens set by the
-- host through the provider; this system never sees card data.
create table if not exists payment_authorizations (
  id uuid primary key,
  party_id uuid not null,
  host_id uuid not null,
  request_id uuid not null references vendor_requests(id) on delete cascade,
  max_amount_cents int not null check (max_amount_cents > 0),
  currency text not null default 'usd',
  provider text not null default 'manual' check (provider in ('manual','stripe')),
  payment_method_ref text,                  -- provider-side reference (e.g. Stripe pm_… on a saved customer), never raw details
  purpose text,                             -- "deposit for the cake", shown on receipts
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists payment_auth_request_idx on payment_authorizations (request_id, created_at desc);

-- Every execution attempt, successful or not, is a row. The audit trail is the point.
create table if not exists payment_attempts (
  id uuid primary key,
  authorization_id uuid not null references payment_authorizations(id) on delete cascade,
  request_id uuid not null,
  amount_cents int not null check (amount_cents > 0),
  currency text not null,
  provider text not null,
  provider_ref text,                        -- e.g. Stripe PaymentIntent id
  status text not null check (status in ('pending_offline','requires_action','succeeded','failed','refused')),
  reason text,                              -- why refused/failed, or offline instructions
  by_kind text not null,                    -- agent | human
  by_name text,
  idempotency_key text,
  created_at timestamptz not null default now()
);
create index if not exists payment_attempts_auth_idx on payment_attempts (authorization_id, created_at desc);
create unique index if not exists payment_attempts_idem on payment_attempts (authorization_id, idempotency_key) where idempotency_key is not null;
