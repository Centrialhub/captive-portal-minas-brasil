
-- =============================================
-- 1) store_public_ips: map public IPs to stores
-- =============================================
CREATE TABLE public.store_public_ips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  public_ip inet NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_store_public_ips_ip UNIQUE (public_ip)
);

ALTER TABLE public.store_public_ips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon denied on store_public_ips"
  ON public.store_public_ips FOR ALL
  USING (false) WITH CHECK (false);

CREATE POLICY "Admin can manage store_public_ips"
  ON public.store_public_ips FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- =============================================
-- 2) rate_limits: distributed rate limiting
-- =============================================
CREATE TABLE public.rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count int NOT NULL DEFAULT 1,
  blocked_until timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon denied on rate_limits"
  ON public.rate_limits FOR ALL
  USING (false) WITH CHECK (false);

-- =============================================
-- 3) rate_limit_hit RPC
-- =============================================
CREATE OR REPLACE FUNCTION public.rate_limit_hit(
  p_key text,
  p_window_seconds int,
  p_max_hits int,
  p_block_seconds int DEFAULT 0
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_now timestamptz := now();
  v_window_start timestamptz := v_now - (p_window_seconds || ' seconds')::interval;
  v_rec record;
  v_allowed boolean;
  v_remaining int;
  v_blocked_until timestamptz;
BEGIN
  -- Upsert: insert or update atomically
  INSERT INTO public.rate_limits (key, window_start, count, blocked_until, updated_at)
  VALUES (p_key, v_now, 1, NULL, v_now)
  ON CONFLICT (key) DO UPDATE SET
    -- Reset window if expired
    window_start = CASE
      WHEN rate_limits.window_start < v_window_start THEN v_now
      ELSE rate_limits.window_start
    END,
    count = CASE
      WHEN rate_limits.window_start < v_window_start THEN 1
      ELSE rate_limits.count + 1
    END,
    blocked_until = CASE
      WHEN rate_limits.window_start >= v_window_start
           AND rate_limits.count + 1 > p_max_hits
           AND p_block_seconds > 0
      THEN v_now + (p_block_seconds || ' seconds')::interval
      WHEN rate_limits.window_start < v_window_start THEN NULL
      ELSE rate_limits.blocked_until
    END,
    updated_at = v_now
  RETURNING * INTO v_rec;

  -- Check if currently blocked
  IF v_rec.blocked_until IS NOT NULL AND v_rec.blocked_until > v_now THEN
    RETURN json_build_object(
      'allowed', false,
      'remaining', 0,
      'blocked_until', v_rec.blocked_until,
      'count', v_rec.count
    );
  END IF;

  v_allowed := v_rec.count <= p_max_hits;
  v_remaining := GREATEST(0, p_max_hits - v_rec.count);

  RETURN json_build_object(
    'allowed', v_allowed,
    'remaining', v_remaining,
    'blocked_until', v_rec.blocked_until,
    'count', v_rec.count
  );
END;
$$;

-- =============================================
-- 4) Unique partial index on captive_verifications
-- =============================================
CREATE UNIQUE INDEX idx_captive_verifications_pending_session
  ON public.captive_verifications (session_id)
  WHERE status = 'pending';

-- =============================================
-- 5) Index on store_public_ips for lookup
-- =============================================
CREATE INDEX idx_store_public_ips_active ON public.store_public_ips (public_ip) WHERE is_active = true;
