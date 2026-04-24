UPDATE public.captive_sessions
SET status = 'failed',
    fail_reason = 'reset_for_hotspot_test',
    updated_at = now()
WHERE client_mac = '9A39E47CE1AD'
  AND status = 'authorized'
  AND authorized_at >= (now() at time zone 'America/Sao_Paulo')::date;