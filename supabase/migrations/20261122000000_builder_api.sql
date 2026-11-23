-- Builder API: hosted bed planner and carpool matcher for anyone building a
-- club, cabin share or trip app. Stateless: builders send their own ids; we keep
-- keys (hashed), a usage log (member ids hashed per builder) and cached
-- neighborhood drive times. Builders are hosts (same magic-link sign-in).

CREATE TABLE IF NOT EXISTS public.builder_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id      uuid NOT NULL REFERENCES public.hosts(id) ON DELETE CASCADE,
  label        text NOT NULL DEFAULT 'default',
  key_prefix   text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT ARRAY['bed_planner', 'carpool'],
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS builder_api_keys_host ON public.builder_api_keys (host_id);

CREATE TABLE IF NOT EXISTS public.builder_api_usage (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id        uuid NOT NULL REFERENCES public.builder_api_keys(id) ON DELETE CASCADE,
  host_id       uuid NOT NULL REFERENCES public.hosts(id) ON DELETE CASCADE,
  endpoint      text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  ms            integer NOT NULL,
  units         integer NOT NULL DEFAULT 0,
  status        smallint NOT NULL,
  member_hashes text[] NOT NULL DEFAULT '{}',
  meta          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS builder_api_usage_key_at ON public.builder_api_usage (key_id, at);
CREATE INDEX IF NOT EXISTS builder_api_usage_host_at ON public.builder_api_usage (host_id, at);

CREATE TABLE IF NOT EXISTS public.area_minutes (
  region     text NOT NULL,
  pair       text NOT NULL,
  minutes    integer NOT NULL CHECK (minutes >= 0),
  source     text NOT NULL DEFAULT 'ai',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (region, pair)
);

ALTER TABLE public.builder_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_api_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.area_minutes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_api_keys, public.builder_api_usage, public.area_minutes FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.builder_active_members(p_host uuid, p_since timestamptz)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(DISTINCT h)::int FROM public.builder_api_usage u, unnest(u.member_hashes) h
  WHERE u.host_id = p_host AND u.status < 400 AND u.at >= p_since;
$$;
REVOKE ALL ON FUNCTION public.builder_active_members(uuid, timestamptz) FROM public, anon, authenticated;
