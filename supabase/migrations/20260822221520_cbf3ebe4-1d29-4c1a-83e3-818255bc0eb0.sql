-- Invariante de Banco de Dados: Garantir que cada tentativa de autenticação gere no máximo uma sessão captive.

-- 1. Preflight: preserve historical rows and detach duplicate associations.
-- Prefer the session already referenced by the attempt. Otherwise keep the
-- newest session, with id as a deterministic tie-breaker. Deleting sessions
-- here would discard audit history and can fail when another table references
-- the row.
CREATE TEMP TABLE captive_attempt_session_winners ON COMMIT DROP AS
SELECT attempt_id, id AS session_id
FROM (
    SELECT
        s.attempt_id,
        s.id,
        row_number() OVER (
            PARTITION BY s.attempt_id
            ORDER BY
                (a.captive_session_id = s.id) DESC,
                s.started_at DESC,
                s.id DESC
        ) AS position
    FROM public.captive_sessions AS s
    LEFT JOIN public.captive_auth_attempts AS a ON a.id = s.attempt_id
    WHERE s.attempt_id IS NOT NULL
) ranked
WHERE position = 1;

UPDATE public.captive_auth_attempts AS a
SET captive_session_id = w.session_id
FROM captive_attempt_session_winners AS w
WHERE a.id = w.attempt_id
  AND a.captive_session_id IS DISTINCT FROM w.session_id;

UPDATE public.captive_sessions AS s
SET attempt_id = NULL
FROM captive_attempt_session_winners AS w
WHERE s.attempt_id = w.attempt_id
  AND s.id <> w.session_id;

-- 2. Aplicar Invariante: Unique Constraint Parcial
DROP INDEX IF EXISTS idx_captive_sessions_attempt_id_unique;
CREATE UNIQUE INDEX idx_captive_sessions_attempt_id_unique 
ON public.captive_sessions (attempt_id) 
WHERE (attempt_id IS NOT NULL);

-- 3. Reforçar Relacionamento: FK com restrição de deleção
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'fk_captive_sessions_attempt'
    ) THEN
        ALTER TABLE public.captive_sessions
        ADD CONSTRAINT fk_captive_sessions_attempt
        FOREIGN KEY (attempt_id)
        REFERENCES public.captive_auth_attempts(id)
        ON DELETE RESTRICT;
    END IF;
END $$;
