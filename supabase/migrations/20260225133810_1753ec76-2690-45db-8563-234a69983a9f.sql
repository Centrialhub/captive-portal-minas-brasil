
-- Create global_settings table (single-row pattern)
CREATE TABLE public.global_settings (
  id integer PRIMARY KEY DEFAULT 1,
  whatsapp_webhook_url text NULL,
  whatsapp_webhook_secret text NULL,
  whatsapp_webhook_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT global_settings_singleton CHECK (id = 1)
);

-- Insert default row
INSERT INTO public.global_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Enable RLS
ALTER TABLE public.global_settings ENABLE ROW LEVEL SECURITY;

-- Only admin can read
CREATE POLICY "Admin can read global_settings"
  ON public.global_settings FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- Only admin can update
CREATE POLICY "Admin can update global_settings"
  ON public.global_settings FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

-- Anon denied
CREATE POLICY "Anon denied on global_settings"
  ON public.global_settings FOR ALL
  USING (false)
  WITH CHECK (false);

-- Trigger for updated_at
CREATE TRIGGER update_global_settings_updated_at
  BEFORE UPDATE ON public.global_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
