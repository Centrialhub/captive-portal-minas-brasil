
-- Create captive_verifications table for OTP login via WhatsApp
CREATE TABLE public.captive_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NULL REFERENCES public.stores(id),
  session_id uuid NOT NULL REFERENCES public.captive_sessions(id) ON DELETE CASCADE,
  lead_id uuid NULL REFERENCES public.leads(id) ON DELETE SET NULL,
  phone text NOT NULL,
  code_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  resends int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_captive_verifications_session_id ON public.captive_verifications(session_id);
CREATE INDEX idx_captive_verifications_phone ON public.captive_verifications(phone);
CREATE INDEX idx_captive_verifications_expires_at ON public.captive_verifications(expires_at);
CREATE INDEX idx_captive_verifications_status ON public.captive_verifications(status);

-- Reuse existing trigger function for updated_at
CREATE TRIGGER update_captive_verifications_updated_at
  BEFORE UPDATE ON public.captive_verifications
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Enable RLS
ALTER TABLE public.captive_verifications ENABLE ROW LEVEL SECURITY;

-- Deny all anon access (write only via service_role in edge functions)
CREATE POLICY "Anon denied on captive_verifications"
  ON public.captive_verifications
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- Admin can read verifications
CREATE POLICY "Admin can read verifications"
  ON public.captive_verifications
  FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'::app_role));
