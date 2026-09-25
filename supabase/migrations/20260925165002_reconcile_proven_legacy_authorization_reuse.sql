-- Repair only the audited interval and only a unique, matching controller
-- confirmation. This migration never creates an operation or sends a command.
WITH candidates AS MATERIALIZED (
  SELECT s.id, s.attempt_id, s.store_id, s.trace_id, s.status AS prior_status,
    s.authorized_at AS prior_authorized_at, s.unifi_last_verify_result AS prior_evidence,
    a.authorization_finished_at AS reused_at,
    min(pr.id::text)::uuid AS source_id, min(pr.unifi_confirmed_at) AS source_confirmed_at
  FROM public.captive_sessions s
  JOIN public.stores st ON st.id=s.store_id AND st.slug='povao'
  JOIN public.captive_auth_attempts a ON a.id=s.attempt_id
  JOIN public.captive_sessions pr ON pr.store_id=s.store_id
    AND pr.user_id=s.user_id AND pr.user_id=a.user_id
    AND public.normalize_mac(pr.client_mac)=public.normalize_mac(s.client_mac)
    AND public.normalize_mac(pr.ap_mac)=public.normalize_mac(s.ap_mac)
    AND pr.ssid IS NOT DISTINCT FROM s.ssid
    AND pr.status='authorized' AND pr.unifi_confirmed_at IS NOT NULL
    AND pr.unifi_confirmed_at<=a.authorization_finished_at
    AND pr.authorized_at BETWEEN a.authorization_finished_at-interval '30 seconds' AND a.authorization_finished_at
  WHERE s.status='submitted' AND a.status='authorized' AND a.authorized=true
    AND s.auth_operation_id IS NULL AND s.unifi_cmd_accepted_at IS NULL AND s.fail_reason IS NULL
    AND s.submitted_at>='2026-09-18T15:40:00Z' AND s.submitted_at<'2026-09-25T15:40:00Z'
  GROUP BY s.id,s.attempt_id,s.store_id,s.trace_id,s.status,s.authorized_at,
    s.unifi_last_verify_result,a.authorization_finished_at
  HAVING count(*)=1
), repaired AS (
  UPDATE public.captive_sessions s SET status='authorized',authorized_at=c.reused_at,
    unifi_confirmed_at=c.source_confirmed_at,fail_reason=NULL,last_error_code=NULL,last_error_message=NULL,
    last_step='authorization_reused',updated_at=clock_timestamp(),
    unifi_last_verify_result=jsonb_build_object('evidence_type','reused_controller_confirmation',
      'reused_from_session_id',c.source_id,'source_confirmed_at',c.source_confirmed_at,
      'reused_at',c.reused_at,'reconciled_at',clock_timestamp(),
      'reconciliation','povao-audit-2026-09-25')
  FROM candidates c WHERE s.id=c.id AND s.status='submitted'
  RETURNING s.id,s.attempt_id,s.store_id,s.trace_id,s.unifi_last_verify_result
), audit AS (
  INSERT INTO public.audit_logs(store_id,entity,entity_id,action,meta)
  SELECT r.store_id,'captive_session',r.id,'legacy_confirmed_reuse_reconciled',
    r.unifi_last_verify_result||jsonb_build_object('prior_status',c.prior_status,
      'prior_authorized_at',c.prior_authorized_at,'prior_evidence',c.prior_evidence)
  FROM repaired r JOIN candidates c ON c.id=r.id RETURNING entity_id
), attempts AS (
  UPDATE public.captive_auth_attempts a SET last_result_code='REUSED_CONFIRMED_RECONCILED',
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('reconciliation','povao-audit-2026-09-25')
  WHERE a.id IN (SELECT attempt_id FROM repaired) RETURNING id
)
INSERT INTO public.portal_events(session_id,trace_id,store_id,event_type,step,status,payload)
SELECT r.id,r.trace_id,r.store_id,'legacy_confirmed_reuse_reconciled','unifi','success',r.unifi_last_verify_result
FROM repaired r;
