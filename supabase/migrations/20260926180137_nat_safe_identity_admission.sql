-- One debit for each capability + identity, including retries after a lost
-- response before durable authorization. These are quota receipts, not proof
-- of identity, presence at the controller, or authorization to the Internet.
CREATE TABLE public.captive_identity_admissions (
  attempt_id uuid NOT NULL REFERENCES public.captive_auth_attempts(id) ON DELETE CASCADE,
  identity_hash text NOT NULL CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  context_hash text NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (attempt_id, identity_hash)
);
ALTER TABLE public.captive_identity_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.captive_identity_admissions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.captive_identity_admissions TO service_role;
-- SECURITY INVOKER needs explicit access to its existing quota table; do not
-- depend on project-specific defaults for newly exposed Data API objects.
GRANT SELECT, INSERT, UPDATE ON TABLE public.rate_limits TO service_role;

CREATE FUNCTION public.admit_captive_identity(
  p_attempt_id uuid, p_resume_token text, p_identity_hash text, p_origin_hash text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  a public.captive_auth_attempts%ROWTYPE;
  r public.rate_limits%ROWTYPE;
  v_context text;
  v_receipt_context text;
  v_request json;
  v_now timestamptz;
  v_keys text[];
  v_key text;
  v_max integer;
  v_block_seconds integer;
  v_block timestamptz;
  v_denied_until timestamptz;
BEGIN
  IF p_resume_token IS NULL OR length(p_resume_token) <> 64
    OR p_identity_hash IS NULL OR p_identity_hash !~ '^[a-f0-9]{64}$'
    OR (p_origin_hash IS NOT NULL AND p_origin_hash !~ '^[a-f0-9]{64}$') THEN
    RETURN jsonb_build_object('allowed',false,'invalid_attempt',true);
  END IF;
  -- Lock the server record, not device/store fields supplied to /identify.
  -- Every concurrent retry sees the same receipt and all quota debits commit
  -- together. Recheck expiration only after the lock is acquired.
  SELECT * INTO a FROM public.captive_auth_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND OR a.resume_token_hash IS NULL OR a.resume_token_hash <> encode(extensions.digest(p_resume_token,'sha256'),'hex')
    OR a.expires_at IS NULL OR a.expires_at <= clock_timestamp() OR a.status IN ('expired','cancelled','failed')
    OR a.store_id IS NULL OR a.client_mac IS NULL OR a.client_mac !~ '^[a-fA-F0-9]{12}$' THEN
    RETURN jsonb_build_object('allowed',false,'invalid_attempt',true);
  END IF;
  v_context:=encode(extensions.digest(jsonb_build_array(a.store_id,upper(a.client_mac),a.ap_mac,a.ssid)::text,'sha256'),'hex');
  SELECT context_hash INTO v_receipt_context FROM public.captive_identity_admissions
    WHERE attempt_id=p_attempt_id AND identity_hash=p_identity_hash;
  IF FOUND AND v_receipt_context <> v_context THEN
    RETURN jsonb_build_object('allowed',false,'invalid_attempt',true);
  END IF;
  -- A short request quota still bounds repeated expensive identity lookups.
  -- Admitted operations bypass this function in the handler and only resume.
  v_request:=public.rate_limit_hit('identity:request:'||p_attempt_id::text,60,20,60);
  IF a.expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('allowed',false,'invalid_attempt',true);
  END IF;
  IF NOT (v_request->>'allowed')::boolean THEN
    RETURN jsonb_build_object('allowed',false,'blocked_until',v_request->>'blocked_until');
  END IF;
  IF v_receipt_context IS NOT NULL THEN
    RETURN jsonb_build_object('allowed',true,'replay',true);
  END IF;

  -- Preserve the existing 8/5-minute identity defense. A device can submit
  -- at most 8 distinct admissions in the same interval. The 1,000/5-minute
  -- origin + store ceiling is an emergency abuse budget, not worker capacity
  -- or an assertion that 1,000 authorizations meet the 120-second SLO.
  -- Missing origin has its own store-scoped budget, never a global unknown IP.
  v_keys:=ARRAY[
    'identity:value:'||p_identity_hash,
    'identity:device:'||a.store_id::text||':'||upper(a.client_mac),
    'identity:origin:'||a.store_id::text||':'||coalesce(p_origin_hash,'missing')
  ];
  -- Use one lock order across identities/devices/origins to avoid deadlocks.
  FOR v_key IN SELECT unnest(v_keys) ORDER BY 1 LOOP
    INSERT INTO public.rate_limits(key,window_start,count,blocked_until,updated_at)
      VALUES(v_key,clock_timestamp(),0,NULL,clock_timestamp()) ON CONFLICT(key) DO NOTHING;
    PERFORM 1 FROM public.rate_limits WHERE key=v_key FOR UPDATE;
  END LOOP;
  v_now:=clock_timestamp();
  IF a.expires_at <= v_now THEN
    RETURN jsonb_build_object('allowed',false,'invalid_attempt',true);
  END IF;
  FOR v_key IN SELECT unnest(v_keys) ORDER BY 1 LOOP
    SELECT * INTO r FROM public.rate_limits WHERE key=v_key;
    v_max:=CASE WHEN v_key LIKE 'identity:origin:%' THEN 1000 ELSE 8 END;
    v_block_seconds:=CASE WHEN v_key LIKE 'identity:value:%' THEN 900 ELSE 300 END;
    v_block:=NULL;
    IF r.blocked_until>v_now THEN
      v_block:=r.blocked_until;
    ELSIF r.window_start+interval '300 seconds'>v_now AND r.count>=v_max THEN
      -- An origin quota has no additional penalty; the advertised wait ends
      -- at its actual window boundary so a 60s reply cannot become a new 60s
      -- block repeatedly while the same full window is still running.
      v_block:=CASE WHEN v_key LIKE 'identity:origin:%' THEN r.window_start+interval '300 seconds'
        ELSE v_now+make_interval(secs=>v_block_seconds) END;
      UPDATE public.rate_limits SET blocked_until=v_block,updated_at=v_now WHERE key=v_key;
    END IF;
    IF v_block IS NOT NULL THEN v_denied_until:=greatest(v_denied_until,v_block); END IF;
  END LOOP;
  IF v_denied_until IS NOT NULL THEN
    -- No admission dimension is charged when another one rejects. The
    -- independent request counter intentionally records an actual request.
    RETURN jsonb_build_object('allowed',false,'blocked_until',v_denied_until);
  END IF;
  UPDATE public.rate_limits SET
    count=CASE WHEN window_start+interval '300 seconds'<=v_now THEN 1 ELSE count+1 END,
    window_start=CASE WHEN window_start+interval '300 seconds'<=v_now THEN v_now ELSE window_start END,
    blocked_until=NULL,updated_at=v_now WHERE key=ANY(v_keys);
  INSERT INTO public.captive_identity_admissions(attempt_id,identity_hash,context_hash)
    VALUES(p_attempt_id,p_identity_hash,v_context);
  RETURN jsonb_build_object('allowed',true,'replay',false);
END;
$$;
REVOKE ALL ON FUNCTION public.admit_captive_identity(uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_captive_identity(uuid,text,text,text) TO service_role;
