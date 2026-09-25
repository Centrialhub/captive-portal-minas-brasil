-- Forward-only repair of the synthetic recovery findings. No jobs are activated.
-- Existing operation identities, deadlines and ambiguous-send exclusions are preserved.
CREATE TABLE public.captive_auth_recovery_failures (
  operation_id uuid PRIMARY KEY REFERENCES public.captive_auth_operations(id) ON DELETE CASCADE,
  failure_count integer NOT NULL CHECK (failure_count>0),
  last_sqlstate text NOT NULL CHECK(last_sqlstate ~ '^[A-Z0-9]{5}$'),
  first_failed_at timestamptz NOT NULL,
  last_failed_at timestamptz NOT NULL,
  next_retry_at timestamptz NOT NULL
);
ALTER TABLE public.captive_auth_recovery_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.captive_auth_recovery_failures FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.captive_auth_recovery_failures TO service_role;
CREATE INDEX captive_auth_recovery_failure_due ON public.captive_auth_recovery_failures(next_retry_at);
CREATE INDEX captive_auth_controller_live_lease
  ON public.captive_auth_operations(controller_key,site_id,lease_expires_at)
  WHERE status IN ('sending','verifying');

-- Each item is atomic, while a bad audit/projection row cannot poison a whole
-- batch. Only SQLSTATE is retained: SQLERRM can contain identities or payloads.
CREATE FUNCTION public.try_expire_captive_auth_operation(p_operation_id uuid,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.captive_auth_operations%ROWTYPE; v_now timestamptz; v_retry timestamptz;
BEGIN
  BEGIN
    SELECT * INTO o FROM public.captive_auth_operations WHERE id=p_operation_id FOR UPDATE;
    IF NOT FOUND OR o.status NOT IN ('queued','sending','verifying') THEN RETURN false; END IF;
    v_now:=clock_timestamp();
    UPDATE public.captive_auth_operations SET status='expired_unconfirmed',completed_at=v_now,
      last_error_code=p_reason,lease_owner=NULL,lease_expires_at=NULL,
      lease_version=lease_version+1,updated_at=v_now WHERE id=o.id;
    PERFORM public.sync_captive_auth_operation(o.id);
    DELETE FROM public.captive_auth_recovery_failures WHERE operation_id=o.id;
    RETURN true;
  EXCEPTION WHEN OTHERS THEN
    -- Rollback above restores operation, members, audit and due work together.
    -- The operation lock held by the outer loop remains ours after rollback.
    v_now:=clock_timestamp();
    INSERT INTO public.captive_auth_recovery_failures(operation_id,failure_count,last_sqlstate,
      first_failed_at,last_failed_at,next_retry_at)
    VALUES(p_operation_id,1,SQLSTATE,v_now,v_now,v_now+interval '10 seconds')
    ON CONFLICT(operation_id) DO UPDATE SET
      failure_count=least(captive_auth_recovery_failures.failure_count+1,1000000),
      last_sqlstate=excluded.last_sqlstate,last_failed_at=v_now,
      next_retry_at=v_now+make_interval(secs=>least(300,10*power(2,least(captive_auth_recovery_failures.failure_count,5)))::integer)
    RETURNING next_retry_at INTO v_retry;
    INSERT INTO public.captive_auth_work_due(operation_id,due_at) VALUES(p_operation_id,v_retry)
      ON CONFLICT(operation_id) DO UPDATE SET due_at=excluded.due_at,updated_at=v_now;
    RETURN false;
  END;
END;
$$;
REVOKE ALL ON FUNCTION public.try_expire_captive_auth_operation(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.expire_captive_auth_operations(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o record; v_count integer:=0; v_now timestamptz:=clock_timestamp(); v_reason text;
BEGIN
  FOR o IN SELECT op.* FROM public.captive_auth_operations op
    WHERE op.status IN ('queued','sending','verifying')
      AND (coalesce(op.verification_deadline+interval '20 seconds',op.created_at+interval '110 seconds')<=v_now
        OR (op.status='queued' AND op.verification_deadline<v_now+interval '16 seconds'))
      AND NOT EXISTS(SELECT 1 FROM public.captive_auth_recovery_failures f
        WHERE f.operation_id=op.id AND f.next_retry_at>v_now)
    ORDER BY op.created_at,op.id LIMIT greatest(1,least(500,p_limit)) FOR UPDATE OF op SKIP LOCKED
  LOOP
    v_reason:=CASE WHEN o.first_sent_at IS NULL THEN 'AUTHORIZATION_NOT_DISPATCHED'
      WHEN o.status='queued' THEN 'AUTHORIZATION_PREPARATION_BUDGET_EXHAUSTED'
      ELSE 'RECONCILIATION_DEADLINE_EXCEEDED' END;
    IF public.try_expire_captive_auth_operation(o.id,v_reason) THEN v_count:=v_count+1; END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_captive_auth_operations(p_lease_owner text,p_limit integer DEFAULT 10,
  p_operation_id uuid DEFAULT NULL,p_allow_send boolean DEFAULT true)
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.captive_auth_operations%ROWTYPE; v_action text; v_now timestamptz; v_send boolean;
  v_live_leases integer;
BEGIN
  IF nullif(p_lease_owner,'') IS NULL OR length(p_lease_owner)>128 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'INVALID_LEASE_CONTEXT'; END IF;
  PERFORM public.expire_captive_auth_operations(100);
  v_now:=clock_timestamp();
  SELECT p_allow_send AND sends_enabled INTO v_send FROM public.captive_auth_worker_config WHERE singleton;
  FOR o IN SELECT op.* FROM public.captive_auth_operations op
    JOIN public.captive_auth_work_due w ON w.operation_id=op.id
    WHERE op.status IN ('queued','sending','verifying') AND w.due_at<=v_now
      AND (op.lease_expires_at IS NULL OR op.lease_expires_at<=v_now)
      AND (p_operation_id IS NULL OR op.id=p_operation_id)
      AND (op.status<>'queued' OR v_send)
      AND coalesce(op.verification_deadline+interval '20 seconds',op.created_at+interval '110 seconds')>v_now
      AND (op.status<>'queued' OR op.verification_deadline IS NULL OR op.verification_deadline>=v_now+interval '16 seconds')
      AND NOT EXISTS(SELECT 1 FROM public.captive_auth_recovery_failures f WHERE f.operation_id=op.id)
      -- Optimistic prefilter prevents a full controller from consuming the
      -- candidate LIMIT ahead of independent controllers. Recheck under lock.
      AND (SELECT count(*) FROM public.captive_auth_operations active
        WHERE active.controller_key=op.controller_key AND active.site_id=op.site_id
          AND active.status IN ('sending','verifying') AND active.lease_expires_at>v_now)<16
    -- A previously sent operation gets capacity before another new command.
    ORDER BY (op.status='queued'),
      CASE WHEN op.status='queued' THEN op.created_at+interval '110 seconds' ELSE op.verification_deadline END,
      w.due_at,op.id LIMIT p_limit FOR UPDATE OF op SKIP LOCKED
  LOOP
    -- Every path, including an inline operationId claim, shares one controller
    -- capacity limit. Never wait for this lock while holding operation rows.
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'captive-controller-leases|'||o.controller_key||'|'||o.site_id,0)) THEN CONTINUE; END IF;
    v_now:=clock_timestamp();
    IF coalesce(o.verification_deadline+interval '20 seconds',o.created_at+interval '110 seconds')<=v_now THEN CONTINUE; END IF;
    IF o.status='queued' AND o.verification_deadline<v_now+interval '16 seconds' THEN
      PERFORM public.try_expire_captive_auth_operation(o.id,'AUTHORIZATION_PREPARATION_BUDGET_EXHAUSTED'); CONTINUE;
    END IF;
    v_action:=CASE WHEN o.status='queued' THEN 'send' ELSE 'verify' END;
    SELECT count(*) INTO v_live_leases FROM public.captive_auth_operations active
      WHERE active.controller_key=o.controller_key AND active.site_id=o.site_id
        AND active.status IN ('sending','verifying') AND active.lease_expires_at>v_now;
    IF v_live_leases>=16 THEN CONTINUE; END IF;
    -- A targeted browser request must not leapfrog due verification elsewhere
    -- on the same controller. Its committed queued intent remains recoverable.
    IF v_action='send' AND EXISTS (
      SELECT 1 FROM public.captive_auth_operations verifying
        JOIN public.captive_auth_work_due due ON due.operation_id=verifying.id
      WHERE verifying.controller_key=o.controller_key AND verifying.site_id=o.site_id
        AND verifying.status IN ('sending','verifying') AND due.due_at<=v_now
        AND (verifying.lease_expires_at IS NULL OR verifying.lease_expires_at<=v_now)
        AND verifying.verification_deadline+interval '20 seconds'>=v_now+interval '16 seconds'
        AND NOT EXISTS(SELECT 1 FROM public.captive_auth_recovery_failures f WHERE f.operation_id=verifying.id)
    ) THEN CONTINUE; END IF;
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

CREATE OR REPLACE FUNCTION public.sync_captive_auth_operation(p_operation_id uuid)
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
      authorized=o.status='confirmed',
      authorization_attempts=CASE WHEN o.command_dispatched_at IS NOT NULL THEN greatest(authorization_attempts,1) ELSE authorization_attempts END,
      redirect_url=CASE WHEN o.status='confirmed' THEN o.redirect_url END,
      fail_reason=CASE WHEN o.status='confirmed' THEN NULL ELSE o.last_error_code END,
      last_result_code=upper(o.status),authorization_finished_at=o.completed_at,
      consumed_at=CASE WHEN o.status='confirmed' THEN coalesce(consumed_at,o.completed_at) ELSE consumed_at END,
      lease_owner=NULL,lease_expires_at=NULL
    WHERE id=m.id;
    UPDATE public.captive_sessions SET
      status=CASE WHEN o.status='confirmed' THEN 'authorized'::public.session_status ELSE 'failed'::public.session_status END,
      authorized_at=CASE WHEN o.status='confirmed' THEN o.confirmed_at END,
      unifi_confirmed_at=CASE WHEN o.status='confirmed' THEN o.confirmed_at END,
      unifi_authorize_called_at=coalesce(unifi_authorize_called_at,o.command_dispatched_at),
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
  DELETE FROM public.captive_auth_recovery_failures WHERE operation_id=o.id;
  PERFORM set_config('captive.auth_operation_writer',coalesce(v_previous_writer,''),true);
END;
$$;

CREATE OR REPLACE FUNCTION public.join_captive_auth_operation(
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
  v_existing jsonb;
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
  v_now:=clock_timestamp();
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
    SELECT * INTO a FROM public.captive_auth_attempts WHERE id=p_attempt_id FOR UPDATE;
    IF a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ATTEMPT_EXPIRED'; END IF;
    v_existing:=public.get_captive_auth_operation(p_attempt_id,p_resume_token);
    IF v_existing->>'disposition'<>'found' THEN
      RETURN v_existing||jsonb_build_object('operation',NULL);
    END IF;
    RETURN jsonb_build_object('disposition','joined','operation',v_existing->'operation',
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
  v_now:=clock_timestamp();
  IF (o.status='confirmed' AND (o.confirmed_at<=v_now-interval '30 seconds' OR o.authorized_until IS NULL OR o.authorized_until<=v_now))
    OR (o.status='expired_unconfirmed' AND o.completed_at<=v_now-interval '30 seconds') THEN o:=NULL; END IF;
  IF o.id IS NOT NULL AND (o.user_id<>p_user_id OR o.ssid IS DISTINCT FROM v_ssid OR
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
  v_now:=clock_timestamp();
  IF a.expires_at<=v_now THEN RAISE EXCEPTION 'ATTEMPT_EXPIRED'; END IF;
  IF a.resume_token_hash IS DISTINCT FROM encode(extensions.digest(p_resume_token,'sha256'),'hex')
    OR (a.user_id IS NOT NULL AND a.user_id<>p_user_id)
    OR (a.store_id IS NOT NULL AND a.store_id<>p_store_id)
    OR public.normalize_mac(a.client_mac) IS DISTINCT FROM v_mac
    OR public.normalize_mac(a.ap_mac) IS DISTINCT FROM v_ap
    OR a.ssid IS DISTINCT FROM v_ssid THEN RAISE EXCEPTION 'OPERATION_CONTEXT_MISMATCH'; END IF;
  IF a.auth_operation_id IS NOT NULL THEN
    v_existing:=public.get_captive_auth_operation(p_attempt_id,p_resume_token);
    IF v_existing->>'disposition'<>'found' THEN RETURN v_existing||jsonb_build_object('operation',NULL); END IF;
    RETURN jsonb_build_object('disposition','joined','operation',v_existing->'operation','session_id',a.captive_session_id);
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
  IF a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ATTEMPT_EXPIRED'; END IF;
  IF o.status='confirmed' THEN
    IF o.confirmed_at<=clock_timestamp()-interval '30 seconds' OR o.authorized_until IS NULL OR o.authorized_until<=clock_timestamp() THEN
      RAISE EXCEPTION 'AUTHORIZATION_RECEIPT_STALE'; END IF;
    PERFORM public.sync_captive_auth_operation(o.id); v_disposition:='confirmed';
  END IF;
  PERFORM set_config('captive.auth_operation_writer',coalesce(v_previous_writer,''),true);
  RETURN jsonb_build_object('disposition',v_disposition,'operation',public.captive_auth_operation_result(o.id),
    'session_id',v_session_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_captive_auth_operation_lease(p_operation_id uuid,p_lease_owner text,p_lease_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.captive_auth_operations%ROWTYPE; v_now timestamptz; v_expiry timestamptz;
BEGIN
  SELECT * INTO o FROM public.captive_auth_operations WHERE id=p_operation_id FOR UPDATE;
  v_now:=clock_timestamp();
  IF NOT FOUND OR o.status NOT IN ('sending','verifying') OR nullif(p_lease_owner,'') IS NULL
    OR o.lease_owner IS DISTINCT FROM p_lease_owner OR o.lease_version IS DISTINCT FROM p_lease_version
    OR o.lease_expires_at IS NULL OR o.lease_expires_at<=v_now
    OR o.verification_deadline+interval '20 seconds'<=v_now THEN RETURN false; END IF;
  v_expiry:=least(v_now+interval '30 seconds',o.verification_deadline+interval '20 seconds');
  UPDATE public.captive_auth_operations SET lease_expires_at=v_expiry,updated_at=v_now WHERE id=o.id;
  UPDATE public.captive_auth_work_due SET due_at=v_expiry,updated_at=v_now WHERE operation_id=o.id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_captive_auth_operation(p_operation_id uuid,p_lease_owner text,p_lease_version bigint,
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
  IF v_terminal IS NULL AND p_outcome IN ('accepted','unknown') AND p_evidence->'command_sent'='true'::jsonb THEN
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

-- The bounded worker may drain for 50s; transport must outlive that budget.
CREATE OR REPLACE FUNCTION public.dispatch_captive_auth_worker()
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
      'x-captive-worker-token',v_secret),body=>'{}'::jsonb,timeout_milliseconds=>55000) INTO v_request;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.captive_auth_worker_config SET last_error_code='WORKER_DISPATCH_'||SQLSTATE WHERE singleton;
    RETURN NULL;
  END;
  UPDATE public.captive_auth_worker_config SET last_dispatch_at=clock_timestamp(),
    last_request_id=v_request,last_error_code=NULL WHERE singleton;
  RETURN v_request;
END;
$$;
