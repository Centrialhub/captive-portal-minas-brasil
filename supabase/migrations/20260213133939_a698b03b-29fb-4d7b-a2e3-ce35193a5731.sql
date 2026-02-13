
-- Enum for session status
CREATE TYPE public.session_status AS ENUM ('started', 'submitted', 'authorized', 'failed');

-- Enum for admin roles
CREATE TYPE public.app_role AS ENUM ('admin');

-- 1) stores
CREATE TABLE public.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  city text,
  is_active boolean NOT NULL DEFAULT true,
  unifi_site_id text,
  unifi_controller_url text,
  unifi_api_key_or_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2) consent_versions
CREATE TABLE public.consent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text UNIQUE NOT NULL,
  text text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3) captive_sessions
CREATE TABLE public.captive_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  client_mac text,
  client_ip text,
  ap_mac text,
  ssid text,
  user_agent text,
  redirect_url text,
  status session_status NOT NULL DEFAULT 'started',
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  authorized_at timestamptz,
  fail_reason text
);

-- 4) leads
CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.captive_sessions(id) ON DELETE SET NULL,
  name text NOT NULL,
  email text,
  phone text,
  client_mac text,
  created_at timestamptz NOT NULL DEFAULT now(),
  consented_at timestamptz NOT NULL,
  consent_version text NOT NULL,
  consent_text_hash text,
  source text NOT NULL DEFAULT 'captive_portal'
);

-- 5) audit_logs
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid,
  entity text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 6) user_roles (for admin access)
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  UNIQUE(user_id, role)
);

-- INDEXES
CREATE INDEX idx_leads_store_created ON public.leads(store_id, created_at DESC);
CREATE INDEX idx_sessions_store_started ON public.captive_sessions(store_id, started_at DESC);
CREATE INDEX idx_leads_mac ON public.leads(client_mac);
CREATE INDEX idx_stores_slug ON public.stores(slug);
CREATE INDEX idx_sessions_status ON public.captive_sessions(status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_stores_updated_at
  BEFORE UPDATE ON public.stores
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Security definer function for role check
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- MAC normalization function
CREATE OR REPLACE FUNCTION public.normalize_mac(mac text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(regexp_replace(COALESCE(mac, ''), '[^a-fA-F0-9]', '', 'g'))
$$;

-- Trigger to normalize MACs on insert/update for captive_sessions
CREATE OR REPLACE FUNCTION public.normalize_session_mac()
RETURNS TRIGGER AS $$
BEGIN
  NEW.client_mac = public.normalize_mac(NEW.client_mac);
  NEW.ap_mac = public.normalize_mac(NEW.ap_mac);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_normalize_session_mac
  BEFORE INSERT OR UPDATE ON public.captive_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_session_mac();

-- Trigger to normalize MAC on leads
CREATE OR REPLACE FUNCTION public.normalize_lead_mac()
RETURNS TRIGGER AS $$
BEGIN
  NEW.client_mac = public.normalize_mac(NEW.client_mac);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_normalize_lead_mac
  BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_lead_mac();

-- ========== RLS ==========

-- stores: public can read slug/name/is_active only via edge functions (service role)
-- admin can do everything
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read basic store info"
  ON public.stores FOR SELECT
  USING (true);

CREATE POLICY "Admin can manage stores"
  ON public.stores FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- captive_sessions: no public access, service role only + admin read
ALTER TABLE public.captive_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can read sessions"
  ON public.captive_sessions FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- leads: no public access, service role only + admin read
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can read leads"
  ON public.leads FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- consent_versions: public read active
ALTER TABLE public.consent_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read active consent"
  ON public.consent_versions FOR SELECT
  USING (is_active = true);

CREATE POLICY "Admin can manage consent"
  ON public.consent_versions FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- audit_logs: admin read only
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can read audit logs"
  ON public.audit_logs FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- user_roles: admin read
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can read roles"
  ON public.user_roles FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Create a view for public store info (hides sensitive fields)
CREATE VIEW public.stores_public AS
  SELECT id, slug, name, city, is_active
  FROM public.stores;
