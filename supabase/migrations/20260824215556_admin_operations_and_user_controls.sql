-- Administrative controls are service-role-only. The browser never receives
-- direct grants for blocks, marketing status, or audit records.
CREATE TABLE IF NOT EXISTS public.user_blocks (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  blocked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_blocks_reason_not_blank CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT user_blocks_expiry_after_block CHECK (expires_at IS NULL OR expires_at > blocked_at)
);

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_blocks FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.user_blocks TO service_role;

CREATE INDEX IF NOT EXISTS idx_user_blocks_expires_at
  ON public.user_blocks (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked_by
  ON public.user_blocks (blocked_by);

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS marketing_status text NOT NULL DEFAULT 'eligible',
  ADD COLUMN IF NOT EXISTS marketing_status_reason text,
  ADD COLUMN IF NOT EXISTS marketing_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS marketing_updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leads_marketing_status_allowed'
      AND conrelid = 'public.leads'::regclass
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_marketing_status_allowed
      CHECK (marketing_status IN ('eligible', 'opted_out', 'blocked', 'anonymized'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_leads_marketing_status_last_seen
  ON public.leads (marketing_status, last_seen_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_leads_marketing_updated_by
  ON public.leads (marketing_updated_by)
  WHERE marketing_updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON public.audit_logs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_action_created
  ON public.audit_logs (entity, action, created_at DESC);

COMMENT ON TABLE public.user_blocks IS
  'Immediate application-level access blocks managed by authenticated administrators.';
COMMENT ON COLUMN public.leads.marketing_status IS
  'Marketing eligibility and LGPD suppression state managed by administrators.';
COMMENT ON COLUMN public.leads.anonymized_at IS
  'Timestamp when directly identifying lead data was irreversibly removed.';
