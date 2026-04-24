-- Reset daily authorization usage for all MACs
-- Move today's "authorized" sessions to "submitted" so they no longer count
-- toward the per-MAC daily authorization limit.
UPDATE public.captive_sessions
SET status = 'submitted',
    authorized_at = NULL,
    fail_reason = COALESCE(fail_reason, 'manual_daily_reset')
WHERE status = 'authorized'
  AND authorized_at >= date_trunc('day', now() AT TIME ZONE 'UTC');

-- Audit log
INSERT INTO public.audit_logs (action, entity, meta)
VALUES ('daily_usage_reset', 'captive_sessions', jsonb_build_object('reset_at', now()));