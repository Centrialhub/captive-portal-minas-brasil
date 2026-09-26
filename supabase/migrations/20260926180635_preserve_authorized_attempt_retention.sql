-- Preserve the longer retention when legacy session/attempt status disagrees.
-- No data changes. CREATE OR REPLACE keeps the existing private-function ACLs.
-- Based on 20260926180129; only the three attempt-retention conditions change.

CREATE OR REPLACE FUNCTION captive_internal.retirable_auth_operations(p_now timestamptz)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT o.id FROM public.captive_auth_operations o
  WHERE o.status IN ('confirmed','rejected','expired_unconfirmed')
    AND o.completed_at < p_now - CASE WHEN o.status='confirmed' THEN interval '365 days' ELSE interval '180 days' END
    AND (o.authorized_until IS NULL OR o.authorized_until <= p_now)
    AND (o.confirmed_at IS NULL OR o.confirmed_at < p_now - interval '30 seconds')
    AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= p_now)
    -- A recent participant preserves the whole operation, including older members.
    AND NOT EXISTS (
      SELECT 1 FROM public.captive_auth_operation_members m
      JOIN public.captive_auth_attempts a ON a.id=m.attempt_id
      JOIN public.captive_sessions s ON s.id=m.session_id
      WHERE m.operation_id=o.id AND (
        m.joined_at >= p_now - CASE WHEN o.status='confirmed' THEN interval '365 days' ELSE interval '180 days' END
        OR a.created_at >= p_now - CASE WHEN s.status='authorized' OR a.status='authorized' OR a.authorized THEN interval '365 days' ELSE interval '180 days' END
        OR a.expires_at > p_now OR a.lease_expires_at > p_now
        OR s.started_at >= p_now - CASE WHEN s.status='authorized' THEN interval '365 days' ELSE interval '180 days' END
        OR s.authorized_at >= p_now - interval '365 days'
        OR s.submitted_at >= p_now - interval '180 days'
        OR a.auth_operation_id IS DISTINCT FROM o.id OR s.auth_operation_id IS DISTINCT FROM o.id
        OR a.captive_session_id IS DISTINCT FROM s.id OR s.attempt_id IS DISTINCT FROM a.id
        OR EXISTS (SELECT 1 FROM public.captive_auth_attempts other WHERE other.captive_session_id=s.id AND other.id<>a.id)
        OR EXISTS (SELECT 1 FROM public.oauth_browser_handoffs h WHERE h.attempt_id=a.id AND h.expires_at>p_now)
        OR EXISTS (SELECT 1 FROM public.captive_verifications v WHERE v.session_id=s.id AND (v.created_at >= p_now-interval '30 days' OR v.expires_at > p_now))
        OR EXISTS (SELECT 1 FROM public.portal_events e WHERE e.session_id=s.id AND e.created_at >= p_now-interval '180 days')
      ))
    -- Do not repair inconsistent links by deleting data. Leave them for diagnosis.
    AND NOT EXISTS (SELECT 1 FROM public.captive_sessions s WHERE s.auth_operation_id=o.id
      AND NOT EXISTS (SELECT 1 FROM public.captive_auth_operation_members m WHERE m.operation_id=o.id AND m.session_id=s.id))
    AND NOT EXISTS (SELECT 1 FROM public.captive_auth_attempts a WHERE a.auth_operation_id=o.id
      AND NOT EXISTS (SELECT 1 FROM public.captive_auth_operation_members m WHERE m.operation_id=o.id AND m.attempt_id=a.id))
    AND NOT EXISTS (SELECT 1 FROM public.captive_auth_operation_events e WHERE e.operation_id=o.id
      AND e.created_at >= p_now-CASE WHEN o.status='confirmed' THEN interval '365 days' ELSE interval '180 days' END);
$$;

CREATE OR REPLACE FUNCTION captive_internal.retirable_captive_sessions(p_now timestamptz, p_operations uuid[])
RETURNS TABLE(id uuid, attempt_id uuid, operation_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT s.id,s.attempt_id,s.auth_operation_id FROM public.captive_sessions s
  LEFT JOIN public.captive_auth_attempts a ON a.id=s.attempt_id
  WHERE (s.auth_operation_id=ANY(p_operations) OR (
    s.auth_operation_id IS NULL
    AND s.started_at < p_now-CASE WHEN s.status='authorized' THEN interval '365 days' ELSE interval '180 days' END
    AND (s.authorized_at IS NULL OR s.authorized_at < p_now-interval '365 days')
    AND (s.submitted_at IS NULL OR s.submitted_at < p_now-interval '180 days')
    AND NOT EXISTS (SELECT 1 FROM public.captive_auth_operation_members m WHERE m.session_id=s.id)
    AND (a.id IS NULL OR (a.auth_operation_id IS NULL
      AND a.created_at < p_now-CASE WHEN s.status='authorized' OR a.status='authorized' OR a.authorized THEN interval '365 days' ELSE interval '180 days' END
      AND a.expires_at <= p_now AND (a.lease_expires_at IS NULL OR a.lease_expires_at<=p_now)
      AND NOT EXISTS (SELECT 1 FROM public.oauth_browser_handoffs h WHERE h.attempt_id=a.id AND h.expires_at>p_now)
      AND (a.captive_session_id IS NULL OR a.captive_session_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM public.captive_auth_operation_members m WHERE m.attempt_id=a.id)))
    AND NOT EXISTS (SELECT 1 FROM public.captive_auth_attempts other WHERE other.captive_session_id=s.id AND other.id IS DISTINCT FROM a.id)
    AND NOT EXISTS (SELECT 1 FROM public.captive_verifications v WHERE v.session_id=s.id AND (v.created_at>=p_now-interval '30 days' OR v.expires_at>p_now))
    AND NOT EXISTS (SELECT 1 FROM public.portal_events e WHERE e.session_id=s.id AND e.created_at>=p_now-interval '180 days')
  ));
$$;

CREATE OR REPLACE FUNCTION captive_internal.captive_housekeeping(p_dry_run boolean, p_batch_size integer, p_actor_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '250ms' AS $$
DECLARE
  v_now timestamptz:=statement_timestamp();
  v_operations uuid[]:='{}'; v_sessions uuid[]:='{}'; v_attempts uuid[]:='{}';
  v_ids jsonb; v_count integer; v_other_count integer; v_orphans uuid[]; r record;
  v_previous_writer text:=current_setting('captive.auth_operation_writer',true);
  v_counts jsonb:=jsonb_build_object('expired_verifications',0,'old_rate_limits',0,'old_sessions',0,
    'old_auth_attempts',0,'old_auth_operations',0,'old_operation_events',0,'old_audit_logs',0,
    'expired_oauth_handoffs',0,'expired_auth_attempts',0,'failed_stale_sessions',0);
BEGIN
  IF p_dry_run IS NULL OR p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'INVALID_HOUSEKEEPING_BATCH';
  END IF;
  -- Prevent two maintenance passes from selecting the same graph; client work is
  -- independent. A busy pass is observable, never reported as successful cleanup.
  IF NOT p_dry_run AND NOT pg_try_advisory_xact_lock(726341,1) THEN
    RAISE EXCEPTION 'HOUSEKEEPING_BUSY';
  END IF;
  FOR r IN SELECT o.id FROM public.captive_auth_operations o
    WHERE o.id IN (SELECT captive_internal.retirable_auth_operations(v_now))
    ORDER BY o.completed_at,o.id LIMIT p_batch_size
  LOOP
    IF NOT p_dry_run THEN
      PERFORM 1 FROM public.captive_auth_operations WHERE id=r.id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN CONTINUE; END IF;
      IF NOT EXISTS (SELECT 1 FROM captive_internal.retirable_auth_operations(v_now) id WHERE id=r.id) THEN CONTINUE; END IF;
    END IF;
    v_operations:=array_append(v_operations,r.id);
  END LOOP;
  -- Common lock order with the authorization coordinator: operation -> attempt ->
  -- session. Never detach an auth_operation_id or disable its immutable-state guard.
  FOR r IN SELECT c.* FROM captive_internal.retirable_captive_sessions(v_now,v_operations) c
    JOIN public.captive_sessions s ON s.id=c.id ORDER BY s.started_at,c.id LIMIT p_batch_size
  LOOP
    IF NOT p_dry_run THEN
      IF r.attempt_id IS NOT NULL THEN
        PERFORM 1 FROM public.captive_auth_attempts WHERE id=r.attempt_id FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN CONTINUE; END IF;
      END IF;
      PERFORM 1 FROM public.captive_sessions WHERE id=r.id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN CONTINUE; END IF;
      IF NOT EXISTS (SELECT 1 FROM captive_internal.retirable_captive_sessions(v_now,v_operations) c WHERE c.id=r.id) THEN CONTINUE; END IF;
    END IF;
    v_sessions:=array_append(v_sessions,r.id);
    IF r.attempt_id IS NOT NULL THEN v_attempts:=array_append(v_attempts,r.attempt_id); END IF;
  END LOOP;
  -- Abandoned pre-session attempts and their admission receipts share the same
  -- 180/365 day policy and attempt budget. No valid capability or link is removed.
  EXECUTE 'SELECT coalesce(array_agg(a.id),''{}''::uuid[]) FROM (
    SELECT a.id FROM public.captive_auth_attempts a
    WHERE a.auth_operation_id IS NULL AND a.captive_session_id IS NULL
      AND a.created_at < $1-CASE WHEN a.status=''authorized'' OR a.authorized THEN interval ''365 days'' ELSE interval ''180 days'' END
      AND a.expires_at <= $1 AND (a.lease_expires_at IS NULL OR a.lease_expires_at <= $1)
      AND NOT EXISTS (SELECT 1 FROM public.captive_sessions s WHERE s.attempt_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM public.captive_auth_operation_members m WHERE m.attempt_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM public.oauth_browser_handoffs h WHERE h.attempt_id=a.id AND h.expires_at>$1)
    ORDER BY a.created_at,a.id LIMIT $2 '||CASE WHEN p_dry_run THEN '' ELSE 'FOR UPDATE SKIP LOCKED' END||') a'
    INTO v_orphans USING v_now,p_batch_size-cardinality(v_attempts);
  v_attempts:=v_attempts||v_orphans;
  v_counts:=v_counts||jsonb_build_object('old_sessions',cardinality(v_sessions),'old_auth_attempts',cardinality(v_attempts));

  IF NOT p_dry_run THEN
    DELETE FROM public.captive_auth_operation_members WHERE session_id=ANY(v_sessions);
    FOR r IN SELECT id,auth_operation_id FROM public.captive_auth_attempts WHERE id=ANY(v_attempts) LOOP
      PERFORM set_config('captive.auth_operation_writer',coalesce(r.auth_operation_id::text,''),true);
      UPDATE public.captive_auth_attempts SET captive_session_id=NULL WHERE id=r.id;
    END LOOP;
    PERFORM set_config('captive.auth_operation_writer',coalesce(v_previous_writer,''),true);
    -- Existing lead FK keeps the lead and sets only its expired session link to NULL.
    -- Expired OTP rows are explicitly counted, before the existing session cascade.
    DELETE FROM public.captive_verifications WHERE session_id=ANY(v_sessions);
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_counts:=v_counts||jsonb_build_object('expired_verifications',v_count);
    DELETE FROM public.oauth_browser_handoffs WHERE attempt_id=ANY(v_attempts);
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_counts:=v_counts||jsonb_build_object('expired_oauth_handoffs',v_count);
    DELETE FROM public.captive_sessions WHERE id=ANY(v_sessions);
    DELETE FROM public.captive_auth_attempts WHERE id=ANY(v_attempts);
  ELSE
    SELECT count(*)::integer INTO v_count FROM public.captive_verifications WHERE session_id=ANY(v_sessions);
    v_counts:=v_counts||jsonb_build_object('expired_verifications',v_count);
    SELECT count(*)::integer INTO v_count FROM public.oauth_browser_handoffs WHERE attempt_id=ANY(v_attempts);
    v_counts:=v_counts||jsonb_build_object('expired_oauth_handoffs',v_count);
  END IF;

  -- Fixed, internal predicates only. The same bounded candidates power preview and
  -- execution; all failures propagate and roll back this entire transaction.
  FOR r IN SELECT * FROM (VALUES
    ('captive_verifications','id','expires_at < $1-interval ''30 days'' AND status IN (''pending'',''expired'',''locked'') AND (session_id IS NULL OR NOT(session_id=ANY($3)))','expired_verifications'),
    ('rate_limits','key','updated_at < $1-interval ''1 day'' AND (blocked_until IS NULL OR blocked_until <= $1)','old_rate_limits'),
    ('audit_logs','id','created_at < $1-interval ''180 days''','old_audit_logs'),
    ('oauth_browser_handoffs','id','expires_at < $1 AND NOT(attempt_id=ANY($4))','expired_oauth_handoffs')
  ) AS rules(table_name,key_name,predicate,counter)
  LOOP
    EXECUTE format('SELECT coalesce(jsonb_agg(x.%1$I),''[]''::jsonb) FROM (SELECT %1$I FROM public.%2$I WHERE %3$s ORDER BY %1$I LIMIT $2 %4$s) x',
      r.key_name,r.table_name,r.predicate,CASE WHEN p_dry_run THEN '' ELSE 'FOR UPDATE SKIP LOCKED' END)
      INTO v_ids USING v_now,p_batch_size,v_sessions,v_attempts;
    v_count:=jsonb_array_length(v_ids);
    IF NOT p_dry_run THEN
      EXECUTE format('DELETE FROM public.%I WHERE %I::text IN (SELECT jsonb_array_elements_text($1))',r.table_name,r.key_name) USING v_ids;
      GET DIAGNOSTICS v_count=ROW_COUNT;
    END IF;
    v_counts:=jsonb_set(v_counts,ARRAY[r.counter],to_jsonb((v_counts->>r.counter)::integer+v_count));
  END LOOP;

  -- Operation events are bounded separately. Keep the operation until its last
  -- participant and event are gone; very large old groups can finish over many runs.
  SELECT coalesce(array_agg(o.id),'{}') INTO v_operations FROM public.captive_auth_operations o
    WHERE o.id=ANY(v_operations)
      AND NOT EXISTS (SELECT 1 FROM public.captive_auth_operation_members m WHERE m.operation_id=o.id AND NOT(m.session_id=ANY(v_sessions)))
      AND NOT EXISTS (SELECT 1 FROM public.captive_sessions s WHERE s.auth_operation_id=o.id AND NOT(s.id=ANY(v_sessions)))
      AND NOT EXISTS (SELECT 1 FROM public.captive_auth_attempts a WHERE a.auth_operation_id=o.id AND NOT(a.id=ANY(v_attempts)));
  SELECT coalesce(jsonb_agg(e.id),'[]') INTO v_ids FROM
    (SELECT id FROM public.captive_auth_operation_events WHERE operation_id=ANY(v_operations) ORDER BY id LIMIT p_batch_size) e;
  v_count:=jsonb_array_length(v_ids);
  IF NOT p_dry_run THEN
    DELETE FROM public.captive_auth_operation_events WHERE id::text IN (SELECT jsonb_array_elements_text(v_ids));
    GET DIAGNOSTICS v_count=ROW_COUNT;
  END IF;
  v_counts:=v_counts||jsonb_build_object('old_operation_events',v_count);
  SELECT count(*)::integer INTO v_count FROM public.captive_auth_operations o WHERE o.id=ANY(v_operations)
    AND NOT EXISTS (SELECT 1 FROM public.captive_auth_operation_events e WHERE e.operation_id=o.id AND NOT(e.id::text IN (SELECT jsonb_array_elements_text(v_ids))));
  IF NOT p_dry_run THEN
    DELETE FROM public.captive_auth_work_due w WHERE w.operation_id=ANY(v_operations)
      AND NOT EXISTS (SELECT 1 FROM public.captive_auth_operation_events e WHERE e.operation_id=w.operation_id);
    DELETE FROM public.captive_auth_operations o WHERE o.id=ANY(v_operations)
      AND NOT EXISTS (SELECT 1 FROM public.captive_auth_operation_events e WHERE e.operation_id=o.id);
    GET DIAGNOSTICS v_count=ROW_COUNT;
  END IF;
  v_counts:=v_counts||jsonb_build_object('old_auth_operations',v_count);

  -- Preserve legacy stale-attempt expiration, now within the same atomic batch.
  SELECT coalesce(array_agg(a.id),'{}') INTO v_attempts FROM (
    SELECT id FROM public.captive_auth_attempts WHERE status='authorizing' AND expires_at<=v_now
      AND auth_operation_id IS NULL AND NOT(id=ANY(v_attempts)) ORDER BY expires_at,id LIMIT p_batch_size
  ) a;
  IF NOT p_dry_run THEN
    WITH expired AS (
      UPDATE public.captive_auth_attempts SET status='expired',fail_reason=coalesce(fail_reason,'ATTEMPT_EXPIRED'),
        authorization_finished_at=coalesce(authorization_finished_at,v_now),lease_owner=NULL,lease_expires_at=NULL
      WHERE id=ANY(v_attempts) AND status='authorizing' AND expires_at<=v_now AND auth_operation_id IS NULL RETURNING captive_session_id
    ), sessions AS (
      UPDATE public.captive_sessions SET status='failed',fail_reason='ATTEMPT_EXPIRED',last_error_code='ATTEMPT_EXPIRED',updated_at=v_now
      WHERE id IN (SELECT captive_session_id FROM expired) AND status IN ('started','submitted') AND auth_operation_id IS NULL RETURNING id
    ) SELECT (SELECT count(*)::integer FROM expired),(SELECT count(*)::integer FROM sessions) INTO v_count,v_other_count;
  ELSE
    v_count:=cardinality(v_attempts);
    SELECT count(*)::integer INTO v_other_count FROM public.captive_sessions s JOIN public.captive_auth_attempts a ON a.captive_session_id=s.id
      WHERE a.id=ANY(v_attempts) AND s.status IN ('started','submitted') AND s.auth_operation_id IS NULL;
  END IF;
  v_counts:=v_counts||jsonb_build_object('expired_auth_attempts',v_count,'failed_stale_sessions',v_other_count);
  IF NOT p_dry_run AND p_actor_user_id IS NOT NULL THEN
    INSERT INTO public.audit_logs(entity,action,meta) VALUES('system','housekeeping',
      jsonb_build_object('actor_user_id',p_actor_user_id,'cleaned',v_counts,'batch_size',p_batch_size));
  END IF;
  RETURN v_counts;
END;
$$;
