-- Enforce a server-authoritative CPF gate.

-- Ensure profiles table exists with needed structure
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'profiles') THEN
        CREATE TABLE public.profiles (
            id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
            full_name TEXT,
            email TEXT,
            phone_digits TEXT,
            cpf_digits TEXT UNIQUE,
            cpf_required BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        );
    END IF;
END $$;

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Revoke all direct permissions first to reset
REVOKE ALL ON public.profiles FROM anon, authenticated;

-- Grant minimal permissions: only select for the owner
GRANT SELECT ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

-- Define/Update RLS Policy
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile" ON public.profiles
    FOR SELECT TO authenticated USING (auth.uid() = id);

-- Secure function to update profile (SECURITY DEFINER bypasses RLS safely)
CREATE OR REPLACE FUNCTION public.secure_update_profile(
    _user_id UUID,
    _full_name TEXT,
    _phone_digits TEXT,
    _cpf_digits TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    _existing_user UUID;
BEGIN
    -- Validation: Check if CPF is already taken
    SELECT id INTO _existing_user
    FROM public.profiles
    WHERE cpf_digits = _cpf_digits AND id != _user_id
    LIMIT 1;

    IF _existing_user IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CPF_ALREADY_EXISTS');
    END IF;

    -- Update the profile
    UPDATE public.profiles
    SET 
        full_name = COALESCE(_full_name, full_name),
        phone_digits = COALESCE(_phone_digits, phone_digits),
        cpf_digits = _cpf_digits,
        cpf_required = FALSE,
        updated_at = now()
    WHERE id = _user_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;
