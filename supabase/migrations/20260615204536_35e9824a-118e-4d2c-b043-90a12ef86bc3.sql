CREATE TABLE public.store_access_points (
  ap_mac TEXT NOT NULL PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto_discovered', 'imported')),
  name TEXT,
  last_seen_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_store_access_points_store_id ON public.store_access_points(store_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_access_points TO authenticated;
GRANT ALL ON public.store_access_points TO service_role;

ALTER TABLE public.store_access_points ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view all access points"
  ON public.store_access_points FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert access points"
  ON public.store_access_points FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update access points"
  ON public.store_access_points FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete access points"
  ON public.store_access_points FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_store_access_points_updated_at
  BEFORE UPDATE ON public.store_access_points
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger para normalizar o MAC do AP (uppercase, sem separadores)
CREATE OR REPLACE FUNCTION public.normalize_access_point_mac()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.ap_mac = public.normalize_mac(NEW.ap_mac);
  IF NEW.ap_mac IS NULL OR length(NEW.ap_mac) <> 12 THEN
    RAISE EXCEPTION 'Invalid AP MAC address';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_store_access_points_normalize_mac
  BEFORE INSERT OR UPDATE ON public.store_access_points
  FOR EACH ROW EXECUTE FUNCTION public.normalize_access_point_mac();