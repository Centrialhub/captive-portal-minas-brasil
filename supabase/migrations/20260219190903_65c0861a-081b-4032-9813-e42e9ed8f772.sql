
-- 1) Adicionar colunas origin_* em leads
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS origin_ip TEXT NULL,
  ADD COLUMN IF NOT EXISTS origin_city TEXT NULL,
  ADD COLUMN IF NOT EXISTS origin_region TEXT NULL,
  ADD COLUMN IF NOT EXISTS origin_country TEXT NULL,
  ADD COLUMN IF NOT EXISTS origin_isp TEXT NULL,
  ADD COLUMN IF NOT EXISTS origin_asn TEXT NULL,
  ADD COLUMN IF NOT EXISTS origin_source TEXT NOT NULL DEFAULT 'none';

-- Índices em leads
CREATE INDEX IF NOT EXISTS idx_leads_origin_ip ON public.leads(origin_ip);
CREATE INDEX IF NOT EXISTS idx_leads_origin_city ON public.leads(origin_city);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON public.leads(created_at DESC);

-- 2) Tornar store_id nullable em leads e captive_sessions (para modo sem loja)
ALTER TABLE public.leads ALTER COLUMN store_id DROP NOT NULL;
ALTER TABLE public.captive_sessions ALTER COLUMN store_id DROP NOT NULL;

-- 3) Criar tabela origin_ip_clusters (cache GeoIP + agrupamento)
CREATE TABLE IF NOT EXISTS public.origin_ip_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ip TEXT UNIQUE NOT NULL,
  city TEXT NULL,
  region TEXT NULL,
  country TEXT NULL,
  isp TEXT NULL,
  asn TEXT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lead_count BIGINT NOT NULL DEFAULT 0,
  last_geoip_at TIMESTAMPTZ NULL,
  geoip_provider TEXT NULL,
  geoip_confidence SMALLINT NULL,
  notes TEXT NULL
);

-- RLS em origin_ip_clusters
ALTER TABLE public.origin_ip_clusters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can read clusters"
  ON public.origin_ip_clusters
  FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anon denied on clusters"
  ON public.origin_ip_clusters
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- Índices em origin_ip_clusters
CREATE INDEX IF NOT EXISTS idx_clusters_public_ip ON public.origin_ip_clusters(public_ip);
CREATE INDEX IF NOT EXISTS idx_clusters_city ON public.origin_ip_clusters(city);
CREATE INDEX IF NOT EXISTS idx_clusters_last_seen ON public.origin_ip_clusters(last_seen_at DESC);
