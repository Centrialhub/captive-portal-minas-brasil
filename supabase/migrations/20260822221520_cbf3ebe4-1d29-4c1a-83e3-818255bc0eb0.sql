-- Invariante de Banco de Dados: Garantir que cada tentativa de autenticação gere no máximo uma sessão captive.

-- 1. Preflight: Identificar e limpar duplicatas que violam a regra de negócio.
DO $$
DECLARE
    dups_count INTEGER;
BEGIN
    SELECT count(*) INTO dups_count
    FROM (
        SELECT attempt_id 
        FROM public.captive_sessions 
        WHERE attempt_id IS NOT NULL 
        GROUP BY attempt_id 
        HAVING count(*) > 1
    ) s;

    IF dups_count > 0 THEN
        DELETE FROM public.captive_sessions a
        USING public.captive_sessions b
        WHERE a.attempt_id = b.attempt_id 
          AND a.created_at < b.created_at
          AND a.attempt_id IS NOT NULL;
    END IF;
END $$;

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
