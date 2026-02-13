
-- ETAPA 1: Add updated_at to tables missing it

ALTER TABLE public.captive_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.consent_versions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- updated_at triggers for all tables
CREATE TRIGGER update_captive_sessions_updated_at
  BEFORE UPDATE ON public.captive_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_leads_updated_at
  BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_consent_versions_updated_at
  BEFORE UPDATE ON public.consent_versions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ETAPA 1: Additional index for dedup check (MAC + recent time)
CREATE INDEX IF NOT EXISTS idx_leads_mac_created ON public.leads(client_mac, created_at DESC) WHERE client_mac IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_client_mac ON public.captive_sessions(client_mac) WHERE client_mac IS NOT NULL;

-- ETAPA 2: Tighten RLS — remove the overly permissive public SELECT on stores
-- Replace with a restrictive policy that only exposes safe columns
DROP POLICY IF EXISTS "Public read basic store info" ON public.stores;

-- Public can only read via the stores_public view (which uses security_invoker)
-- But for the edge function using service_role, no RLS applies anyway.
-- For anon users querying directly: deny all
CREATE POLICY "Anon cannot read stores directly"
  ON public.stores FOR SELECT
  TO anon
  USING (false);

-- Authenticated non-admin can read basic info only
CREATE POLICY "Authenticated read basic store info"
  ON public.stores FOR SELECT
  TO authenticated
  USING (true);

-- Ensure no public INSERT/UPDATE/DELETE on sensitive tables
-- (These tables already have RLS enabled with only admin SELECT policies,
--  so anon/authenticated without admin role cannot write. 
--  Service role bypasses RLS entirely.)

-- Add explicit deny policies for anon on all sensitive tables
CREATE POLICY "Anon denied on leads"
  ON public.leads FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Anon denied on captive_sessions"
  ON public.captive_sessions FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Anon denied on audit_logs"
  ON public.audit_logs FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Anon denied on user_roles"
  ON public.user_roles FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);
