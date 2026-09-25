-- Durable network authorization. No production jobs or legacy commands are started
-- by this migration. Configure the worker explicitly after deploying its endpoint.
CREATE TABLE public.captive_auth_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  controller_key text NOT NULL CHECK (length(controller_key) BETWEEN 1 AND 512),
  site_id text NOT NULL CHECK (length(site_id) BETWEEN 1 AND 128),
  client_mac text NOT NULL CHECK (client_mac ~ '^[A-F0-9]{12}$'),
  ap_mac text,
  ssid text,
  association_key text NOT NULL CHECK (length(association_key) BETWEEN 1 AND 256),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','sending','verifying','confirmed','rejected','expired_unconfirmed')),
  command jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(command)='object'),
  grant_seconds integer NOT NULL CHECK (grant_seconds BETWEEN 60 AND 86400),
  redirect_url text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  first_sent_at timestamptz,
  command_dispatched_at timestamptz,
  command_accepted_at timestamptz,
  verification_deadline timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_version bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  send_count integer NOT NULL DEFAULT 0 CHECK (send_count BETWEEN 0 AND 1),
  prepare_failures integer NOT NULL DEFAULT 0 CHECK (prepare_failures BETWEEN 0 AND 3),
  verify_count integer NOT NULL DEFAULT 0 CHECK (verify_count >= 0),
  evidence jsonb,
  confirmed_at timestamptz,
  authorized_until timestamptz,
  completed_at timestamptz,
  last_error_code text,
  imported_legacy boolean NOT NULL DEFAULT false,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (verification_deadline IS NULL OR first_sent_at IS NOT NULL),
  CHECK (status <> 'confirmed' OR (confirmed_at IS NOT NULL
    AND (authorized_until IS NOT NULL OR evidence->>'validity_basis'='observed_only')
    AND evidence IS NOT NULL AND evidence @> '{"found":true,"authorized":true}'::jsonb
    AND evidence->>'mac'=client_mac)),
  CHECK ((status IN ('confirmed','rejected','expired_unconfirmed')) = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX captive_auth_operation_active_device
  ON public.captive_auth_operations(store_id,controller_key,site_id,client_mac)
  WHERE status IN ('queued','sending','verifying');
CREATE INDEX captive_auth_operation_recent_device
  ON public.captive_auth_operations(store_id,controller_key,site_id,client_mac,created_at DESC);
CREATE INDEX captive_auth_operation_expiration
  ON public.captive_auth_operations(verification_deadline)
  WHERE status IN ('queued','sending','verifying');

-- Logged application table, unlike the transient transport tables in pg_net.
CREATE TABLE public.captive_auth_work_due (
  operation_id uuid PRIMARY KEY REFERENCES public.captive_auth_operations(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX captive_auth_work_due_at ON public.captive_auth_work_due(due_at);
CREATE TABLE public.captive_auth_operation_members (
  attempt_id uuid PRIMARY KEY REFERENCES public.captive_auth_attempts(id),
  session_id uuid NOT NULL UNIQUE REFERENCES public.captive_sessions(id),
  operation_id uuid NOT NULL REFERENCES public.captive_auth_operations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX captive_auth_operation_members_operation ON public.captive_auth_operation_members(operation_id);
CREATE TABLE public.captive_auth_operation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES public.captive_auth_operations(id),
  event_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(operation_id,event_key)
);
ALTER TABLE public.captive_auth_attempts ADD COLUMN auth_operation_id uuid REFERENCES public.captive_auth_operations(id);
ALTER TABLE public.captive_sessions ADD COLUMN auth_operation_id uuid REFERENCES public.captive_auth_operations(id);
CREATE INDEX captive_auth_attempt_operation ON public.captive_auth_attempts(auth_operation_id) WHERE auth_operation_id IS NOT NULL;
CREATE INDEX captive_session_auth_operation ON public.captive_sessions(auth_operation_id) WHERE auth_operation_id IS NOT NULL;

CREATE TABLE public.captive_auth_worker_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  sends_enabled boolean NOT NULL DEFAULT false,
  endpoint text,
  vault_secret_id uuid,
  token_hash text,
  last_tick_at timestamptz,
  last_dispatch_at timestamptz,
  last_worker_finished_at timestamptz,
  last_worker_failed_count integer,
  last_request_id bigint,
  last_error_code text
);
INSERT INTO public.captive_auth_worker_config(singleton) VALUES(true);

ALTER TABLE public.captive_auth_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.captive_auth_work_due ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.captive_auth_operation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.captive_auth_operation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.captive_auth_worker_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.captive_auth_operations,public.captive_auth_work_due,
  public.captive_auth_operation_members,public.captive_auth_operation_events,
  public.captive_auth_worker_config FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.captive_auth_operation_events_id_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.captive_auth_operations,public.captive_auth_work_due,
  public.captive_auth_operation_members,public.captive_auth_operation_events,
  public.captive_auth_worker_config TO service_role;

-- Only backend RPCs write these tables. A public result excludes identity and payload.
CREATE FUNCTION public.captive_auth_operation_result(p_operation_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id',o.id,'operation_id',o.id,'status',o.status,'authorized',o.status='confirmed',
    'processing',o.status IN ('queued','sending','verifying'),'fail_reason',o.last_error_code,
    'deadline_at',o.verification_deadline,
    'redirect_url',CASE WHEN o.status='confirmed' THEN o.redirect_url END,
    'created_at',o.created_at,'first_sent_at',o.first_sent_at,
    'verification_deadline',o.verification_deadline,'next_check_at',o.next_check_at,
    'confirmed_at',o.confirmed_at,'authorized_until',o.authorized_until,
    'completed_at',o.completed_at,'last_error_code',o.last_error_code,
    'retry_after_ms',CASE WHEN o.status='expired_unconfirmed'
      THEN greatest(0,ceil(extract(epoch FROM (o.completed_at+interval '30 seconds'-clock_timestamp()))*1000)::integer)
      WHEN o.status IN ('queued','sending','verifying')
      THEN greatest(1000,least(10000,ceil(extract(epoch FROM
        (o.next_check_at-clock_timestamp()))*1000)::integer)) ELSE 0 END)
  FROM public.captive_auth_operations o WHERE o.id=p_operation_id;
$$;

-- Internal projection writer: caller holds operation lock; operation -> attempts ->
-- sessions is the common lock order. Cancelled/ineligible attempts are never promoted.
CREATE FUNCTION public.sync_captive_auth_operation(p_operation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.captive_auth_operations%ROWTYPE; m record;
  v_previous_writer text:=current_setting('captive.auth_operation_writer',true);
BEGIN
  SELECT * INTO STRICT o FROM public.captive_auth_operations WHERE id=p_operation_id FOR UPDATE;
  IF o.status NOT IN ('confirmed','rejected','expired_unconfirmed') THEN RETURN; END IF;
  PERFORM set_config('captive.auth_operation_writer',o.id::text,true);
  FOR m IN SELECT a.id,a.captive_session_id,s.trace_id FROM public.captive_auth_operation_members x
    JOIN public.captive_auth_attempts a ON a.id=x.attempt_id
    JOIN public.captive_sessions s ON s.id=x.session_id
    WHERE x.operation_id=o.id AND x.user_id=o.user_id AND a.user_id=o.user_id
      AND a.auth_operation_id=o.id AND s.auth_operation_id=o.id
      AND a.captive_session_id=s.id AND s.attempt_id=a.id
      AND a.status='authorizing' AND s.status IN ('started','submitted')
    ORDER BY a.id FOR UPDATE OF a,s
  LOOP
    UPDATE public.captive_auth_attempts SET
      status=CASE WHEN o.status='confirmed' THEN 'authorized' ELSE 'failed' END,
      authorized=o.status='confirmed', redirect_url=CASE WHEN o.status='confirmed' THEN o.redirect_url END,
      fail_reason=CASE WHEN o.status='confirmed' THEN NULL ELSE o.last_error_code END,
      last_result_code=upper(o.status),authorization_finished_at=o.completed_at,
      consumed_at=CASE WHEN o.status='confirmed' THEN coalesce(consumed_at,o.completed_at) ELSE consumed_at END,
      lease_owner=NULL,lease_expires_at=NULL
    WHERE id=m.id;
    UPDATE public.captive_sessions SET
      status=CASE WHEN o.status='confirmed' THEN 'authorized'::public.session_status ELSE 'failed'::public.session_status END,
      authorized_at=CASE WHEN o.status='confirmed' THEN o.confirmed_at END,
      unifi_confirmed_at=CASE WHEN o.status='confirmed' THEN o.confirmed_at END,
      unifi_cmd_accepted_at=coalesce(unifi_cmd_accepted_at,o.command_accepted_at),
      unifi_last_verify_result=o.evidence,redirect_url=coalesce(o.redirect_url,redirect_url),
      last_step=CASE WHEN o.status='confirmed' THEN 'unifi_confirmed' ELSE 'authorization_finished' END,
      fail_reason=CASE WHEN o.status='confirmed' THEN NULL ELSE o.last_error_code END,
      last_error_code=CASE WHEN o.status='confirmed' THEN NULL ELSE o.last_error_code END,
      updated_at=clock_timestamp()
    WHERE id=m.captive_session_id;
    INSERT INTO public.audit_logs(store_id,entity,entity_id,action,meta)
      VALUES(o.store_id,'captive_session',m.captive_session_id,'auth_operation_'||o.status,
        jsonb_build_object('operation_id',o.id,'attempt_id',m.id,'confirmed_at',o.confirmed_at,
          'authorized_until',o.authorized_until,'error_code',o.last_error_code));
    INSERT INTO public.portal_events(session_id,trace_id,store_id,event_type,step,status,error_code,payload)
      VALUES(m.captive_session_id,m.trace_id,o.store_id,'auth_operation_'||o.status,'unifi',
        CASE WHEN o.status='confirmed' THEN 'success' ELSE 'error' END,o.last_error_code,
        jsonb_build_object('operation_id',o.id,'attempt_id',m.id));
  END LOOP;
  INSERT INTO public.captive_auth_operation_events(operation_id,event_key,payload)
    VALUES(o.id,'terminal',jsonb_build_object('status',o.status,'error_code',o.last_error_code))
    ON CONFLICT(operation_id,event_key) DO NOTHING;
  DELETE FROM public.captive_auth_work_due WHERE operation_id=o.id;
  PERFORM set_config('captive.auth_operation_writer',coalesce(v_previous_writer,''),true);
END;
$$;

CREATE FUNCTION public.join_captive_auth_operation(
  p_attempt_id uuid,p_user_id uuid,p_store_id uuid,p_controller_key text,p_site_id text,
  p_client_mac text,p_ap_mac text,p_association_key text,p_redirect_url text,
  p_command jsonb DEFAULT '{}'::jsonb,p_resume_token text DEFAULT NULL,
  p_session_id uuid DEFAULT NULL,p_session jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  a public.captive_auth_attempts%ROWTYPE; s public.captive_sessions%ROWTYPE;
  o public.captive_auth_operations%ROWTYPE; v_now timestamptz:=clock_timestamp();
  v_mac text:=public.normalize_mac(p_client_mac); v_ap text:=public.normalize_mac(p_ap_mac);
  v_site text:=coalesce(nullif(p_site_id,''),'default'); v_ssid text;
  v_session_id uuid; v_source_at timestamptz; v_accepted_at timestamptz;
  v_disposition text:='joined'; v_daily_limit integer; v_daily_start timestamptz; v_daily_used integer;
  v_legacy public.captive_sessions%ROWTYPE;
  v_previous_writer text:=current_setting('captive.auth_operation_writer',true);
BEGIN
  IF p_user_id IS NULL OR p_store_id IS NULL OR nullif(p_controller_key,'') IS NULL
    OR nullif(p_association_key,'') IS NULL OR nullif(p_resume_token,'') IS NULL
    OR v_mac !~ '^[A-F0-9]{12}$' OR jsonb_typeof(p_command) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_session) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_OPERATION_CONTEXT' USING ERRCODE='22023';
  END IF;
  -- Serialize joins before locking the operation; collision merely serializes extra work.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_store_id::text||'|'||v_mac,0));
  SELECT * INTO a FROM public.captive_auth_attempts WHERE id=p_attempt_id;
  IF NOT FOUND OR a.resume_token_hash IS DISTINCT FROM
    encode(extensions.digest(p_resume_token,'sha256'),'hex') THEN
    RAISE EXCEPTION 'INVALID_RESUME_TOKEN' USING ERRCODE='28000';
  END IF;
  IF a.expires_at<=v_now THEN RAISE EXCEPTION 'ATTEMPT_EXPIRED'; END IF;
  IF (a.user_id IS NOT NULL AND a.user_id<>p_user_id)
    OR (a.store_id IS NOT NULL AND a.store_id<>p_store_id)
    OR public.normalize_mac(a.client_mac) IS DISTINCT FROM v_mac
    OR public.normalize_mac(a.ap_mac) IS DISTINCT FROM v_ap THEN
    RAISE EXCEPTION 'OPERATION_CONTEXT_MISMATCH';
  END IF;
  v_ssid:=a.ssid;
  IF a.auth_operation_id IS NOT NULL THEN
    SELECT * INTO o FROM public.captive_auth_operations WHERE id=a.auth_operation_id FOR UPDATE;
    RETURN jsonb_build_object('disposition','joined','operation',public.captive_auth_operation_result(o.id),
      'session_id',a.captive_session_id);
  END IF;
  IF a.status IN ('authorized','failed','expired','cancelled') THEN
    RAISE EXCEPTION 'ATTEMPT_TERMINAL';
  END IF;
  SELECT * INTO o FROM public.captive_auth_operations
    WHERE store_id=p_store_id AND controller_key=p_controller_key AND site_id=v_site AND client_mac=v_mac
      AND (status IN ('queued','sending','verifying') OR
        (status='confirmed' AND confirmed_at>v_now-interval '30 seconds' AND authorized_until>v_now) OR
        (status='expired_unconfirmed' AND completed_at>v_now-interval '30 seconds'))
    ORDER BY (status IN ('queued','sending','verifying')) DESC,created_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND AND (o.user_id<>p_user_id OR o.ssid IS DISTINCT FROM v_ssid OR
    (o.ap_mac IS DISTINCT FROM v_ap AND NOT (
      o.status IN ('queued','sending','verifying') AND nullif(o.ssid,'') IS NOT NULL
      AND EXISTS(SELECT 1 FROM public.store_access_points WHERE store_id=p_store_id AND ap_mac=o.ap_mac)
      AND EXISTS(SELECT 1 FROM public.store_access_points WHERE store_id=p_store_id AND ap_mac=v_ap)
    ))) THEN
    RETURN jsonb_build_object('disposition','context_conflict','operation',NULL,
      'retry_after_ms',10000,'error_code','DEVICE_OPERATION_IN_PROGRESS');
  END IF;
  IF o.id IS NOT NULL AND o.status='expired_unconfirmed' THEN
    RETURN jsonb_build_object('disposition','unconfirmed_cooldown','operation',NULL,
      'retry_after_ms',greatest(0,ceil(extract(epoch FROM(o.completed_at+interval '30 seconds'-clock_timestamp()))*1000)::integer),
      'error_code','PREVIOUS_AUTHORIZATION_UNCONFIRMED');
  END IF;
  IF o.id IS NULL THEN
    SELECT * INTO v_legacy FROM public.captive_sessions old
      WHERE old.store_id=p_store_id AND old.client_mac=v_mac AND old.status='submitted'
        AND old.auth_operation_id IS NULL AND old.unifi_cmd_accepted_at>v_now-interval '120 seconds'
      ORDER BY old.unifi_cmd_accepted_at DESC LIMIT 1;
    IF FOUND AND (v_legacy.user_id IS DISTINCT FROM p_user_id
      OR public.normalize_mac(v_legacy.ap_mac) IS DISTINCT FROM v_ap OR v_legacy.ssid IS DISTINCT FROM v_ssid) THEN
      RETURN jsonb_build_object('disposition','context_conflict','operation',NULL,
        'retry_after_ms',10000,'error_code','LEGACY_DEVICE_OPERATION_IN_PROGRESS');
    END IF;
    v_daily_limit:=coalesce((p_command->>'max_daily_accesses')::integer,0);
    IF v_daily_limit<0 OR v_daily_limit>100 THEN RAISE EXCEPTION 'INVALID_DAILY_LIMIT'; END IF;
    -- Calculate the window here; caller-provided dates cannot bypass the rule.
    v_daily_start:=date_trunc('day',v_now AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
    IF v_daily_limit>0 THEN
      SELECT (SELECT count(*) FROM public.captive_sessions cs WHERE cs.store_id=p_store_id
        AND cs.client_mac=v_mac AND cs.status='authorized' AND cs.authorized_at>=v_daily_start
        AND cs.auth_operation_id IS NULL) +
        (SELECT count(*) FROM public.captive_auth_operations op WHERE op.store_id=p_store_id
        AND op.client_mac=v_mac AND ((op.status='confirmed' AND op.confirmed_at>=v_daily_start AND op.command_dispatched_at IS NOT NULL)
          OR op.status IN ('queued','sending','verifying')))
      INTO v_daily_used;
      IF v_daily_used>=v_daily_limit THEN RETURN jsonb_build_object('disposition','daily_limit',
        'authorized',false,'processing',false,'fail_reason','DAILY_ACCESS_LIMIT_REACHED'); END IF;
    END IF;
  END IF;
  -- Lock attempt only after operation. Recheck after waiting for another transaction.
  SELECT * INTO a FROM public.captive_auth_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF a.auth_operation_id IS NOT NULL THEN
    RETURN jsonb_build_object('disposition','joined','operation',public.captive_auth_operation_result(a.auth_operation_id),
      'session_id',a.captive_session_id);
  END IF;
  IF a.status IN ('authorized','failed','expired','cancelled') OR a.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'ATTEMPT_NO_LONGER_ELIGIBLE';
  END IF;
  IF p_session_id IS NOT NULL AND a.captive_session_id IS NOT NULL AND p_session_id<>a.captive_session_id THEN
    RAISE EXCEPTION 'SESSION_CONTEXT_MISMATCH';
  END IF;
  v_session_id:=coalesce(a.captive_session_id,p_session_id);
  UPDATE public.captive_auth_attempts SET user_id=p_user_id,store_id=p_store_id WHERE id=a.id;
  IF v_session_id IS NOT NULL THEN
    SELECT * INTO s FROM public.captive_sessions WHERE id=v_session_id FOR UPDATE;
    IF NOT FOUND OR s.attempt_id IS DISTINCT FROM a.id
      OR s.store_id IS DISTINCT FROM p_store_id OR public.normalize_mac(s.client_mac) IS DISTINCT FROM v_mac
      OR (s.user_id IS NOT NULL AND s.user_id<>p_user_id)
      OR s.status NOT IN ('started','submitted') THEN RAISE EXCEPTION 'SESSION_CONTEXT_MISMATCH'; END IF;
  ELSE
    INSERT INTO public.captive_sessions(attempt_id,user_id,store_id,client_mac,ap_mac,ssid,status,
      submitted_at,form_submitted_at,params_received_at,trace_id,auth_method,user_agent,client_ip,captive_timestamp,redirect_url,last_step)
    VALUES(a.id,p_user_id,p_store_id,v_mac,v_ap,v_ssid,'submitted',v_now,v_now,a.created_at,
      left(p_session->>'trace_id',128),left(p_session->>'auth_method',32),
      left(p_session->>'user_agent',512),left(p_session->>'client_ip',64),a.captive_timestamp,
      p_redirect_url,'authorization_queued') RETURNING * INTO s;
    v_session_id:=s.id;
  END IF;
  IF o.id IS NULL THEN
    -- Import only work associated with a current verified request. Never sweep/send old clients.
    IF s.unifi_cmd_accepted_at IS NOT NULL OR a.authorization_attempts>0 OR a.status='authorizing' THEN
      v_source_at:=coalesce(s.unifi_authorize_called_at,s.unifi_cmd_accepted_at,a.authorization_started_at,v_now);
      v_accepted_at:=s.unifi_cmd_accepted_at;
    ELSE
      v_source_at:=coalesce(v_legacy.unifi_authorize_called_at,v_legacy.unifi_cmd_accepted_at);
      v_accepted_at:=v_legacy.unifi_cmd_accepted_at;
    END IF;
    INSERT INTO public.captive_auth_operations(store_id,user_id,controller_key,site_id,client_mac,ap_mac,ssid,
      association_key,command,grant_seconds,redirect_url,status,first_sent_at,command_dispatched_at,verification_deadline,
      command_accepted_at,send_count,imported_legacy)
    VALUES(p_store_id,p_user_id,p_controller_key,v_site,v_mac,v_ap,v_ssid,p_association_key,p_command,
      greatest(60,least(86400,coalesce((p_command->>'minutes')::integer,40)*60)),p_redirect_url,
      CASE WHEN v_source_at IS NULL THEN 'queued' ELSE 'verifying' END,
      CASE WHEN v_source_at IS NOT NULL THEN least(v_source_at,v_now) END,
      CASE WHEN v_accepted_at IS NOT NULL THEN least(v_source_at,v_now) END,
      CASE WHEN v_source_at IS NOT NULL THEN least(v_source_at,v_now)+interval '90 seconds' END,v_accepted_at,
      CASE WHEN v_source_at IS NULL THEN 0 ELSE 1 END,v_source_at IS NOT NULL)
    RETURNING * INTO o;
    INSERT INTO public.captive_auth_work_due(operation_id,due_at) VALUES(o.id,v_now);
    INSERT INTO public.captive_auth_operation_events(operation_id,event_key,payload)
      VALUES(o.id,'created',jsonb_build_object('imported_legacy',o.imported_legacy));
    v_disposition:='created';
  END IF;
  PERFORM set_config('captive.auth_operation_writer',o.id::text,true);
  INSERT INTO public.captive_auth_operation_members(attempt_id,session_id,operation_id,user_id)
    VALUES(a.id,v_session_id,o.id,p_user_id);
  UPDATE public.captive_auth_attempts SET auth_operation_id=o.id,captive_session_id=v_session_id,
    status='authorizing',authorized=false,authorization_started_at=coalesce(authorization_started_at,v_now),
    lease_owner=NULL,lease_expires_at=NULL,fail_reason=NULL WHERE id=a.id;
  UPDATE public.captive_sessions SET auth_operation_id=o.id,user_id=p_user_id,status='submitted',
    submitted_at=coalesce(submitted_at,v_now),form_submitted_at=coalesce(form_submitted_at,v_now),
    params_received_at=coalesce(params_received_at,a.created_at),last_step='authorization_queued',updated_at=v_now WHERE id=v_session_id;
  IF o.status='confirmed' THEN
    PERFORM public.sync_captive_auth_operation(o.id); v_disposition:='confirmed';
  END IF;
  PERFORM set_config('captive.auth_operation_writer',coalesce(v_previous_writer,''),true);
  RETURN jsonb_build_object('disposition',v_disposition,'operation',public.captive_auth_operation_result(o.id),
    'session_id',v_session_id);
END;
$$;

CREATE FUNCTION public.get_captive_auth_operation(p_attempt_id uuid,p_resume_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.captive_auth_attempts%ROWTYPE; o public.captive_auth_operations%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.captive_auth_attempts WHERE id=p_attempt_id;
  IF NOT FOUND OR nullif(p_resume_token,'') IS NULL OR a.resume_token_hash IS DISTINCT FROM
    encode(extensions.digest(p_resume_token,'sha256'),'hex') THEN
    RETURN jsonb_build_object('disposition','invalid_capability');
  END IF;
  IF a.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('disposition','capability_expired'); END IF;
  IF a.auth_operation_id IS NULL THEN RETURN jsonb_build_object('disposition','awaiting_identity',
    'status','awaiting_identity','authorized',false,'processing',false,'session_id',a.captive_session_id); END IF;
  SELECT * INTO o FROM public.captive_auth_operations WHERE id=a.auth_operation_id;
  IF a.user_id IS DISTINCT FROM o.user_id OR NOT EXISTS (
    SELECT 1 FROM public.captive_auth_operation_members m JOIN public.captive_sessions s ON s.id=m.session_id
    WHERE m.attempt_id=a.id AND m.operation_id=o.id AND m.user_id=a.user_id
      AND m.session_id=a.captive_session_id AND s.attempt_id=a.id AND s.auth_operation_id=o.id
      AND s.user_id=a.user_id AND s.store_id=o.store_id
      AND ((o.status='confirmed' AND a.status='authorized' AND s.status='authorized')
        OR (o.status IN ('rejected','expired_unconfirmed') AND a.status='failed' AND s.status='failed')
        OR (o.status IN ('queued','sending','verifying') AND a.status='authorizing' AND s.status='submitted'))
  ) THEN RETURN jsonb_build_object('disposition','state_inconsistent','authorized',false,'processing',false); END IF;
  IF o.status='confirmed' AND (o.authorized_until<=clock_timestamp() OR
    (o.authorized_until IS NULL AND o.confirmed_at<=clock_timestamp()-interval '30 seconds')) THEN
    RETURN jsonb_build_object('disposition','receipt_stale','authorized',false,'processing',false);
  END IF;
  RETURN public.captive_auth_operation_result(a.auth_operation_id)||jsonb_build_object('disposition','found',
    'operation',public.captive_auth_operation_result(a.auth_operation_id),'user_id',a.user_id,
    'session_id',a.captive_session_id);
END;
$$;

-- An optional persistent-login challenge is issued at most once per attempt.
-- A failure to issue it does not change the confirmed network result.
CREATE FUNCTION public.claim_captive_auth_challenge(p_attempt_id uuid,p_resume_token text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.captive_auth_attempts%ROWTYPE; o public.captive_auth_operations%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.captive_auth_attempts WHERE id=p_attempt_id;
  IF NOT FOUND OR a.auth_operation_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO o FROM public.captive_auth_operations WHERE id=a.auth_operation_id FOR UPDATE;
  SELECT * INTO a FROM public.captive_auth_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF nullif(p_resume_token,'') IS NULL OR a.resume_token_hash IS DISTINCT FROM
      encode(extensions.digest(p_resume_token,'sha256'),'hex')
    OR a.expires_at<=clock_timestamp() OR a.status<>'authorized' OR o.status<>'confirmed'
    OR a.user_id IS DISTINCT FROM o.user_id OR a.metadata ? 'challenge_claimed_at'
    OR o.authorized_until<=clock_timestamp()
    OR (o.authorized_until IS NULL AND o.confirmed_at<=clock_timestamp()-interval '30 seconds')
    OR EXISTS(SELECT 1 FROM public.user_blocks WHERE user_id=a.user_id AND (expires_at IS NULL OR expires_at>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=a.user_id AND role='admin') THEN RETURN NULL; END IF;
  UPDATE public.captive_auth_attempts SET metadata=coalesce(metadata,'{}'::jsonb)||
    jsonb_build_object('challenge_claimed_at',clock_timestamp()) WHERE id=a.id;
  RETURN a.user_id;
END;
$$;

CREATE FUNCTION public.claim_captive_auth_operations(p_lease_owner text,p_limit integer DEFAULT 10,
  p_operation_id uuid DEFAULT NULL,p_allow_send boolean DEFAULT true)
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.captive_auth_operations%ROWTYPE; v_action text; v_now timestamptz:=clock_timestamp(); v_send boolean;
BEGIN
  IF nullif(p_lease_owner,'') IS NULL OR length(p_lease_owner)>128 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'INVALID_LEASE_CONTEXT'; END IF;
  PERFORM public.expire_captive_auth_operations(100);
  SELECT p_allow_send AND sends_enabled INTO v_send FROM public.captive_auth_worker_config WHERE singleton;
  FOR o IN SELECT op.* FROM public.captive_auth_operations op
    JOIN public.captive_auth_work_due w ON w.operation_id=op.id
    WHERE op.status IN ('queued','sending','verifying') AND w.due_at<=v_now
      AND (op.lease_expires_at IS NULL OR op.lease_expires_at<=v_now)
      AND (p_operation_id IS NULL OR op.id=p_operation_id)
      AND (op.status<>'queued' OR v_send)
    ORDER BY w.due_at,op.id LIMIT p_limit FOR UPDATE OF op SKIP LOCKED
  LOOP
    v_action:=CASE WHEN o.status='queued' THEN 'send' ELSE 'verify' END;
    UPDATE public.captive_auth_operations SET status=CASE WHEN v_action='send' THEN 'sending' ELSE 'verifying' END,
      first_sent_at=coalesce(first_sent_at,v_now),verification_deadline=coalesce(verification_deadline,v_now+interval '90 seconds'),
      send_count=CASE WHEN v_action='send' THEN 1 ELSE send_count END,
      verify_count=verify_count+CASE WHEN v_action='verify' THEN 1 ELSE 0 END,
      lease_owner=p_lease_owner,lease_version=lease_version+1,
      lease_expires_at=least(v_now+interval '30 seconds',coalesce(verification_deadline,v_now+interval '90 seconds')+interval '20 seconds'),
      updated_at=v_now WHERE id=o.id RETURNING * INTO o;
    UPDATE public.captive_auth_work_due SET due_at=o.lease_expires_at,updated_at=v_now WHERE operation_id=o.id;
    RETURN NEXT to_jsonb(o)||jsonb_build_object('action',v_action,'state',o.status,'deadline_at',o.verification_deadline);
  END LOOP;
END;
$$;

CREATE FUNCTION public.renew_captive_auth_operation_lease(p_operation_id uuid,p_lease_owner text,p_lease_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_expiry timestamptz;
BEGIN
  UPDATE public.captive_auth_operations SET lease_expires_at=least(clock_timestamp()+interval '30 seconds',
    verification_deadline+interval '20 seconds'),updated_at=clock_timestamp()
  WHERE id=p_operation_id AND status IN ('sending','verifying') AND lease_owner=p_lease_owner
    AND lease_version=p_lease_version AND lease_expires_at>clock_timestamp()
    AND verification_deadline+interval '20 seconds'>clock_timestamp()
  RETURNING lease_expires_at INTO v_expiry;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.captive_auth_work_due SET due_at=v_expiry,updated_at=clock_timestamp() WHERE operation_id=p_operation_id;
  RETURN true;
END;
$$;

CREATE FUNCTION public.record_captive_auth_operation(p_operation_id uuid,p_lease_owner text,p_lease_version bigint,
  p_outcome text,p_evidence jsonb DEFAULT NULL,p_error_code text DEFAULT NULL,p_redirect_url text DEFAULT NULL,
  p_authorized_until timestamptz DEFAULT NULL,p_retry_after_seconds integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.captive_auth_operations%ROWTYPE; v_now timestamptz:=clock_timestamp(); v_terminal text;
  v_until timestamptz; v_observed timestamptz; v_requeue boolean:=false; v_command_at timestamptz;
  v_previous_writer text:=current_setting('captive.auth_operation_writer',true);
BEGIN
  SELECT * INTO o FROM public.captive_auth_operations WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',false,'disposition','not_found'); END IF;
  IF o.status IN ('confirmed','rejected','expired_unconfirmed') THEN
    RETURN jsonb_build_object('applied',false,'disposition','already_terminal','operation',public.captive_auth_operation_result(o.id));
  END IF;
  -- Row-lock waits can consume the lease. Do not validate against call-start time.
  v_now:=clock_timestamp();
  IF nullif(p_lease_owner,'') IS NULL OR p_lease_version IS NULL OR o.lease_owner IS DISTINCT FROM p_lease_owner
    OR o.lease_version<>p_lease_version OR o.lease_expires_at IS NULL OR o.lease_expires_at<=v_now THEN
    RETURN jsonb_build_object('applied',false,'disposition','stale_lease','operation',public.captive_auth_operation_result(o.id));
  END IF;
  IF p_outcome NOT IN ('accepted','unknown','pending','confirmed','rejected','not_sent') OR p_outcome IS NULL THEN
    RAISE EXCEPTION 'INVALID_AUTH_OUTCOME'; END IF;
  IF p_outcome='accepted' AND (o.status<>'sending' OR o.send_count<>1 OR
    p_evidence->'command_sent' IS DISTINCT FROM 'true'::jsonb) THEN
    RAISE EXCEPTION 'COMMAND_ACCEPTANCE_EVIDENCE_REQUIRED'; END IF;
  IF p_outcome IN ('accepted','unknown') AND p_evidence->'command_sent'='true'::jsonb THEN
    v_command_at:=coalesce((p_evidence->>'command_sent_at')::timestamptz,o.first_sent_at);
    IF v_command_at<o.first_sent_at-interval '5 seconds' OR v_command_at>v_now+interval '5 seconds' THEN
      RAISE EXCEPTION 'COMMAND_TIMESTAMP_INVALID'; END IF;
  END IF;
  IF p_outcome='not_sent' THEN
    IF o.status<>'sending' OR o.command_accepted_at IS NOT NULL OR o.send_count<>1
      OR p_evidence IS NULL OR p_evidence->'command_sent' IS DISTINCT FROM 'false'::jsonb
      OR nullif(p_error_code,'') IS NULL THEN RAISE EXCEPTION 'KNOWN_UNSENT_EVIDENCE_REQUIRED'; END IF;
    IF o.prepare_failures>=2 THEN
      v_terminal:='rejected'; p_error_code:='AUTHORIZATION_PREPARATION_EXHAUSTED';
    ELSIF v_now>=o.verification_deadline THEN
      v_terminal:='expired_unconfirmed'; p_error_code:='AUTHORIZATION_PREPARATION_DEADLINE';
    ELSE v_requeue:=true;
    END IF;
  ELSIF p_outcome='confirmed' THEN
    IF p_evidence IS NULL OR NOT (p_evidence @> '{"found":true,"authorized":true}'::jsonb)
      OR public.normalize_mac(p_evidence->>'mac') IS DISTINCT FROM o.client_mac
      OR p_evidence->>'site_id' IS DISTINCT FROM o.site_id
      OR p_evidence->>'controller_key' IS DISTINCT FROM o.controller_key
      OR nullif(p_evidence->>'observed_at','') IS NULL THEN RAISE EXCEPTION 'CONFIRMATION_EVIDENCE_REQUIRED'; END IF;
    v_observed:=(p_evidence->>'observed_at')::timestamptz;
    IF v_observed<greatest(o.created_at,o.first_sent_at)-interval '5 seconds' OR v_observed>v_now+interval '5 seconds'
      OR v_observed<v_now-interval '30 seconds' THEN RAISE EXCEPTION 'STALE_CONFIRMATION_EVIDENCE'; END IF;
    IF o.command_accepted_at IS NULL AND p_evidence->>'validity_basis'='observed_only' THEN
      v_until:=NULL;
    ELSE
      v_until:=least(p_authorized_until,o.first_sent_at+make_interval(secs=>o.grant_seconds));
      IF p_authorized_until IS NULL OR v_until<=v_now OR o.command_accepted_at IS NULL THEN
        RAISE EXCEPTION 'AUTHORIZATION_VALIDITY_REQUIRED'; END IF;
    END IF;
    v_terminal:='confirmed';
    p_evidence:=jsonb_set(p_evidence,'{mac}',to_jsonb(o.client_mac));
  ELSIF p_outcome='rejected' THEN
    IF p_evidence IS NULL OR p_evidence->'explicit_rejection' IS DISTINCT FROM 'true'::jsonb
      OR nullif(p_error_code,'') IS NULL OR o.command_accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'EXPLICIT_REJECTION_REQUIRED'; END IF;
    v_terminal:='rejected';
  ELSIF v_now>=o.verification_deadline THEN v_terminal:='expired_unconfirmed';
  END IF;
  UPDATE public.captive_auth_operations SET
    status=CASE WHEN v_requeue THEN 'queued' ELSE coalesce(v_terminal,'verifying') END,
    send_count=CASE WHEN p_outcome='not_sent' THEN 0 ELSE send_count END,
    prepare_failures=prepare_failures+CASE WHEN p_outcome='not_sent' THEN 1 ELSE 0 END,
    command_accepted_at=CASE WHEN p_outcome='accepted' THEN coalesce(command_accepted_at,v_now) ELSE command_accepted_at END,
    command_dispatched_at=CASE WHEN p_outcome IN ('accepted','unknown') AND p_evidence->'command_sent'='true'::jsonb
      THEN coalesce(command_dispatched_at,v_command_at) ELSE command_dispatched_at END,
    evidence=coalesce(p_evidence,evidence),
    confirmed_at=CASE WHEN v_terminal='confirmed' THEN v_observed ELSE confirmed_at END,
    authorized_until=CASE WHEN v_terminal='confirmed' THEN v_until ELSE authorized_until END,
    completed_at=CASE WHEN v_terminal IS NOT NULL THEN v_now END,
    last_error_code=CASE WHEN v_terminal='confirmed' THEN NULL
      WHEN v_terminal='expired_unconfirmed' THEN coalesce(p_error_code,'AUTHORIZATION_UNCONFIRMED') ELSE p_error_code END,
    redirect_url=coalesce(p_redirect_url,redirect_url),lease_owner=NULL,lease_expires_at=NULL,
    next_check_at=least(v_now+make_interval(secs=>CASE WHEN v_requeue THEN 5
      ELSE greatest(1,least(10,coalesce(p_retry_after_seconds,5))) END),verification_deadline),
    updated_at=v_now WHERE id=o.id RETURNING * INTO o;
  PERFORM set_config('captive.auth_operation_writer',o.id::text,true);
  IF p_outcome IN ('accepted','unknown') AND p_evidence->'command_sent'='true'::jsonb THEN
    UPDATE public.captive_auth_attempts SET authorization_attempts=greatest(authorization_attempts,1)
      WHERE auth_operation_id=o.id AND status='authorizing';
    UPDATE public.captive_sessions SET unifi_authorize_called_at=coalesce(unifi_authorize_called_at,o.command_dispatched_at),
      unifi_cmd_accepted_at=coalesce(unifi_cmd_accepted_at,o.command_accepted_at),updated_at=v_now
    WHERE auth_operation_id=o.id AND status IN ('started','submitted');
  END IF;
  INSERT INTO public.captive_auth_operation_events(operation_id,event_key,payload)
    VALUES(o.id,'lease:'||p_lease_version::text,jsonb_build_object('outcome',p_outcome,'error_code',p_error_code));
  IF v_terminal IS NOT NULL THEN PERFORM public.sync_captive_auth_operation(o.id);
  ELSE INSERT INTO public.captive_auth_work_due(operation_id,due_at) VALUES(o.id,o.next_check_at)
    ON CONFLICT(operation_id) DO UPDATE SET due_at=excluded.due_at,updated_at=v_now;
  END IF;
  PERFORM set_config('captive.auth_operation_writer',coalesce(v_previous_writer,''),true);
  RETURN jsonb_build_object('applied',true,'disposition','recorded','operation',public.captive_auth_operation_result(o.id));
END;
$$;

-- Deadline watchdog runs in the database even if the HTTP worker never comes back.
CREATE FUNCTION public.expire_captive_auth_operations(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o record; v_count integer:=0; v_now timestamptz:=clock_timestamp();
BEGIN
  FOR o IN SELECT id FROM public.captive_auth_operations
    WHERE status IN ('queued','sending','verifying')
      AND coalesce(verification_deadline+interval '20 seconds',created_at+interval '110 seconds')<=v_now
    ORDER BY created_at LIMIT greatest(1,least(500,p_limit)) FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.captive_auth_operations SET status='expired_unconfirmed',completed_at=v_now,
      last_error_code=CASE WHEN first_sent_at IS NULL THEN 'AUTHORIZATION_NOT_DISPATCHED' ELSE 'RECONCILIATION_DEADLINE_EXCEEDED' END,
      lease_owner=NULL,lease_expires_at=NULL,lease_version=lease_version+1,updated_at=v_now WHERE id=o.id;
    PERFORM public.sync_captive_auth_operation(o.id); v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.authorize_captive_auth_worker(p_token text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(nullif(p_token,'') IS NOT NULL AND enabled AND token_hash=
    encode(extensions.digest(p_token,'sha256'),'hex'),false)
  FROM public.captive_auth_worker_config WHERE singleton;
$$;

CREATE FUNCTION public.finish_captive_auth_worker(p_failed_count integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.captive_auth_worker_config SET last_worker_finished_at=clock_timestamp(),
    last_worker_failed_count=greatest(0,coalesce(p_failed_count,0)) WHERE singleton;
$$;

CREATE FUNCTION public.dispatch_captive_auth_worker()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.captive_auth_worker_config%ROWTYPE; v_secret text; v_request bigint;
BEGIN
  PERFORM public.expire_captive_auth_operations(100);
  SELECT * INTO c FROM public.captive_auth_worker_config WHERE singleton FOR UPDATE;
  UPDATE public.captive_auth_worker_config SET last_tick_at=clock_timestamp() WHERE singleton;
  IF NOT c.enabled OR NOT EXISTS (SELECT 1 FROM public.captive_auth_work_due w
      JOIN public.captive_auth_operations o ON o.id=w.operation_id
      WHERE w.due_at<=clock_timestamp() AND (o.status<>'queued' OR c.sends_enabled))
    OR c.last_dispatch_at>clock_timestamp()-interval '8 seconds' THEN RETURN NULL; END IF;
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE id=c.vault_secret_id;
  IF v_secret IS NULL THEN
    UPDATE public.captive_auth_worker_config SET last_error_code='WORKER_SECRET_UNAVAILABLE' WHERE singleton;
    RETURN NULL;
  END IF;
  SELECT net.http_post(url=>c.endpoint,headers=>jsonb_build_object('Content-Type','application/json',
      'x-captive-worker-token',v_secret),body=>'{}'::jsonb,timeout_milliseconds=>25000) INTO v_request;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.captive_auth_worker_config SET last_error_code='WORKER_DISPATCH_'||SQLSTATE WHERE singleton;
    RETURN NULL;
  END;
  UPDATE public.captive_auth_worker_config SET last_dispatch_at=clock_timestamp(),
    last_request_id=v_request,last_error_code=NULL WHERE singleton;
  RETURN v_request;
END;
$$;

CREATE FUNCTION public.configure_captive_auth_worker(p_endpoint text,p_enabled boolean DEFAULT true,
  p_sends_enabled boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_secret text; v_secret_id uuid; v_job bigint;
BEGIN
  IF p_endpoint IS NULL OR p_endpoint !~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/captive-portal/cron/auth-reconcile$' THEN
    RAISE EXCEPTION 'INVALID_WORKER_ENDPOINT'; END IF;
  SELECT vault_secret_id INTO v_secret_id FROM public.captive_auth_worker_config WHERE singleton FOR UPDATE;
  v_secret:=encode(extensions.gen_random_bytes(32),'hex');
  IF v_secret_id IS NULL THEN
    SELECT vault.create_secret(v_secret,'captive_auth_worker_v1','Internal captive authorization reconciler') INTO v_secret_id;
  ELSE PERFORM vault.update_secret(v_secret_id,v_secret); END IF;
  UPDATE public.captive_auth_worker_config SET endpoint=p_endpoint,enabled=p_enabled,sends_enabled=p_sends_enabled,
    vault_secret_id=v_secret_id,token_hash=encode(extensions.digest(v_secret,'sha256'),'hex'),last_error_code=NULL WHERE singleton;
  SELECT cron.schedule('captive-auth-reconcile-v1','10 seconds','SELECT public.dispatch_captive_auth_worker();') INTO v_job;
  RETURN jsonb_build_object('configured',true,'enabled',p_enabled,'sends_enabled',p_sends_enabled,'job_id',v_job);
END;
$$;

-- Preserve the real block deadline; polling a blocked key never extends the block.
CREATE OR REPLACE FUNCTION public.rate_limit_hit(p_key text,p_window_seconds integer,p_max_hits integer,p_block_seconds integer DEFAULT 0)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.rate_limits%ROWTYPE; v_now timestamptz:=clock_timestamp(); v_block timestamptz;
BEGIN
  IF nullif(p_key,'') IS NULL OR p_window_seconds IS NULL OR p_window_seconds<=0
    OR p_max_hits IS NULL OR p_max_hits<=0 OR p_block_seconds IS NULL OR p_block_seconds<0 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT'; END IF;
  INSERT INTO public.rate_limits(key,window_start,count,blocked_until,updated_at)
    VALUES(p_key,v_now,0,NULL,v_now) ON CONFLICT(key) DO NOTHING;
  SELECT * INTO r FROM public.rate_limits WHERE key=p_key FOR UPDATE;
  IF r.blocked_until>v_now THEN RETURN json_build_object('allowed',false,'remaining',0,
    'blocked_until',r.blocked_until,'count',r.count,'retry_after_seconds',ceil(extract(epoch FROM(r.blocked_until-v_now)))); END IF;
  IF r.window_start+make_interval(secs=>p_window_seconds)<=v_now THEN
    r.window_start:=v_now; r.count:=0; END IF;
  r.count:=r.count+1;
  v_block:=CASE WHEN r.count>p_max_hits AND p_block_seconds>0 THEN v_now+make_interval(secs=>p_block_seconds) END;
  UPDATE public.rate_limits SET window_start=r.window_start,count=r.count,blocked_until=v_block,updated_at=v_now WHERE key=p_key;
  RETURN json_build_object('allowed',r.count<=p_max_hits,'remaining',greatest(0,p_max_hits-r.count),
    'blocked_until',v_block,'count',r.count,'retry_after_seconds',CASE WHEN r.count<=p_max_hits THEN 0 ELSE
      greatest(1,ceil(extract(epoch FROM(coalesce(v_block,r.window_start+make_interval(secs=>p_window_seconds))-v_now)))) END);
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_stale_auth_attempts()
RETURNS TABLE(expired_attempts integer,failed_sessions integer)
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_attempts integer; v_sessions integer;
BEGIN
  WITH expired AS (
    UPDATE public.captive_auth_attempts SET status='expired',fail_reason=coalesce(fail_reason,'ATTEMPT_EXPIRED'),
      authorization_finished_at=coalesce(authorization_finished_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL
    WHERE status='authorizing' AND expires_at<=clock_timestamp() AND auth_operation_id IS NULL
    RETURNING captive_session_id
  ), sessions AS (
    UPDATE public.captive_sessions SET status='failed',fail_reason='ATTEMPT_EXPIRED',last_error_code='ATTEMPT_EXPIRED',updated_at=clock_timestamp()
    WHERE id IN (SELECT captive_session_id FROM expired WHERE captive_session_id IS NOT NULL)
      AND status IN ('started','submitted') AND auth_operation_id IS NULL RETURNING id
  ) SELECT (SELECT count(*)::integer FROM expired),(SELECT count(*)::integer FROM sessions) INTO v_attempts,v_sessions;
  RETURN QUERY SELECT v_attempts,v_sessions;
END;
$$;

-- Old inflight handlers cannot overwrite state owned by the new state machine.
CREATE FUNCTION public.guard_captive_auth_managed_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.captive_auth_operations%ROWTYPE; v_expected text; v_fields text[];
BEGIN
  IF OLD.auth_operation_id IS NOT NULL AND NEW.auth_operation_id IS DISTINCT FROM OLD.auth_operation_id THEN
    RAISE EXCEPTION 'AUTH_OPERATION_LINK_IMMUTABLE'; END IF;
  IF NEW.auth_operation_id IS NULL THEN RETURN NEW; END IF;
  IF OLD.auth_operation_id IS NULL AND current_setting('captive.auth_operation_writer',true) IS DISTINCT FROM NEW.auth_operation_id::text THEN
    RAISE EXCEPTION 'AUTH_OPERATION_LINK_REQUIRES_RPC'; END IF;
  SELECT * INTO o FROM public.captive_auth_operations WHERE id=NEW.auth_operation_id;
  IF NEW.user_id IS DISTINCT FROM o.user_id OR NEW.store_id IS DISTINCT FROM o.store_id
    OR public.normalize_mac(NEW.client_mac) IS DISTINCT FROM o.client_mac THEN
    RAISE EXCEPTION 'AUTH_OPERATION_IDENTITY_MISMATCH'; END IF;
  v_expected:=CASE WHEN o.status='confirmed' THEN 'authorized'
    WHEN o.status IN ('rejected','expired_unconfirmed') THEN 'failed'
    WHEN TG_TABLE_NAME='captive_auth_attempts' THEN 'authorizing' ELSE 'submitted' END;
  -- Joining an already confirmed operation first establishes the link, then the
  -- internal projection writer completes both entities in this same transaction.
  IF OLD.auth_operation_id IS NULL AND o.status='confirmed' AND NEW.status::text IN ('authorizing','submitted') THEN RETURN NEW; END IF;
  IF NEW.status::text<>v_expected THEN RAISE EXCEPTION 'AUTH_OPERATION_STATE_MANAGED'; END IF;
  IF TG_TABLE_NAME='captive_auth_attempts' THEN
    IF NEW.authorized IS DISTINCT FROM (o.status='confirmed')
      OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'AUTH_OPERATION_LEASE_MANAGED';
    END IF;
    v_fields:=ARRAY['status','authorized','captive_session_id','user_id','store_id','client_mac','ap_mac','ssid',
      'authorization_started_at','authorization_finished_at','lease_owner','lease_expires_at','consumed_at',
      'redirect_url','fail_reason','last_result_code','auth_operation_id','authorization_attempts'];
  ELSE
    v_fields:=ARRAY['status','authorized_at','unifi_confirmed_at','unifi_cmd_accepted_at','unifi_authorize_called_at',
      'unifi_last_verify_result','fail_reason','last_error_code','redirect_url','user_id','store_id','client_mac',
      'ap_mac','ssid','attempt_id','auth_operation_id'];
  END IF;
  IF OLD.auth_operation_id IS NOT NULL
    AND current_setting('captive.auth_operation_writer',true) IS DISTINCT FROM NEW.auth_operation_id::text
    AND EXISTS(SELECT 1 FROM unnest(v_fields) AS f WHERE to_jsonb(NEW)->f IS DISTINCT FROM to_jsonb(OLD)->f) THEN
    RAISE EXCEPTION 'AUTH_OPERATION_WRITE_REQUIRES_RPC';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_captive_auth_attempt_state BEFORE UPDATE ON public.captive_auth_attempts
  FOR EACH ROW EXECUTE FUNCTION public.guard_captive_auth_managed_state();
CREATE TRIGGER guard_captive_session_auth_state BEFORE UPDATE ON public.captive_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_captive_auth_managed_state();

-- New functions are not public APIs even though PostgREST resolves them in public.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT p.oid::regprocedure AS signature,p.proname FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
    ('captive_auth_operation_result','sync_captive_auth_operation','join_captive_auth_operation',
     'get_captive_auth_operation','claim_captive_auth_operations','renew_captive_auth_operation_lease',
     'record_captive_auth_operation','expire_captive_auth_operations','authorize_captive_auth_worker',
     'dispatch_captive_auth_worker','configure_captive_auth_worker','rate_limit_hit','expire_stale_auth_attempts',
     'claim_captive_auth_challenge','finish_captive_auth_worker','guard_captive_auth_managed_state')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',r.signature);
    IF r.proname NOT IN ('captive_auth_operation_result','sync_captive_auth_operation','dispatch_captive_auth_worker','guard_captive_auth_managed_state') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);
    END IF;
  END LOOP;
END $$;
