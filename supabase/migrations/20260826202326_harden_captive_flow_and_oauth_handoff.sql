-- Harden the store/controller contract and add a one-time server-side bridge
-- between captive network assistants and the device's full browser.

ALTER TABLE public.captive_auth_attempts
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES public.stores(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS store_detection_source TEXT;

UPDATE public.captive_auth_attempts AS attempt
SET store_id = store.id
FROM public.stores AS store
WHERE attempt.store_id IS NULL
  AND attempt.store_hint = store.slug;

CREATE INDEX IF NOT EXISTS idx_captive_auth_attempts_store_id
  ON public.captive_auth_attempts(store_id);

-- Every controller request must traverse the public TLS bridge.  Binding the
-- URL to the row slug prevents the admin API from silently reintroducing raw
-- controller ports or a path belonging to another store.
UPDATE public.stores
SET unifi_controller_url = 'https://unifiproxy.minasbrasilwifi.com.br/' || slug
WHERE unifi_controller_url IS NOT NULL;

ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS stores_unifi_controller_url_https;

ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS stores_unifi_controller_url_canonical;

ALTER TABLE public.stores
  ADD CONSTRAINT stores_unifi_controller_url_canonical
  CHECK (
    unifi_controller_url IS NULL
    OR unifi_controller_url = 'https://unifiproxy.minasbrasilwifi.com.br/' || slug
  ) NOT VALID;

ALTER TABLE public.stores
  VALIDATE CONSTRAINT stores_unifi_controller_url_canonical;

CREATE TABLE IF NOT EXISTS public.oauth_browser_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL UNIQUE
    REFERENCES public.captive_auth_attempts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE
    CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_oauth_browser_handoffs_expires_at
  ON public.oauth_browser_handoffs(expires_at);

ALTER TABLE public.oauth_browser_handoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.oauth_browser_handoffs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.oauth_browser_handoffs TO service_role;

CREATE OR REPLACE FUNCTION public.claim_oauth_browser_handoff(
  p_code_hash TEXT,
  p_new_resume_token_hash TEXT
)
RETURNS TABLE(
  attempt_id UUID,
  client_mac TEXT,
  ap_mac TEXT,
  ssid TEXT,
  store_hint TEXT,
  captive_timestamp TEXT,
  requested_redirect_url TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_handoff public.oauth_browser_handoffs%ROWTYPE;
  v_attempt public.captive_auth_attempts%ROWTYPE;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_code_hash !~ '^[a-f0-9]{64}$'
     OR p_new_resume_token_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'HANDOFF_INVALID';
  END IF;

  SELECT * INTO v_handoff
  FROM public.oauth_browser_handoffs
  WHERE code_hash = p_code_hash
  FOR UPDATE;

  IF NOT FOUND
     OR v_handoff.claimed_at IS NOT NULL
     OR v_handoff.expires_at <= v_now THEN
    RAISE EXCEPTION 'HANDOFF_INVALID_OR_EXPIRED';
  END IF;

  SELECT * INTO v_attempt
  FROM public.captive_auth_attempts
  WHERE id = v_handoff.attempt_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_attempt.expires_at <= v_now
     OR v_attempt.status IN ('authorized', 'failed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'ATTEMPT_INVALID_OR_EXPIRED';
  END IF;

  UPDATE public.oauth_browser_handoffs
  SET claimed_at = v_now
  WHERE id = v_handoff.id;

  UPDATE public.captive_auth_attempts
  SET resume_token_hash = p_new_resume_token_hash,
      status = CASE WHEN status = 'created' THEN 'oauth_redirected' ELSE status END,
      metadata = COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object('browser_handoff_claimed_at', v_now)
  WHERE id = v_attempt.id;

  RETURN QUERY SELECT
    v_attempt.id,
    v_attempt.client_mac,
    v_attempt.ap_mac,
    v_attempt.ssid,
    v_attempt.store_hint,
    v_attempt.captive_timestamp,
    v_attempt.metadata->>'requested_redirect_url';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_oauth_browser_handoff(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_oauth_browser_handoff(TEXT, TEXT)
  TO service_role;
