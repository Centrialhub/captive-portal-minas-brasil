-- 1. Create secure_set_cpf for service_role only
CREATE OR REPLACE FUNCTION public.secure_set_cpf(
    _user_id UUID,
    _cpf_digits TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    _existing_id UUID;
BEGIN
    -- Do not accept null or empty CPF
    IF _cpf_digits IS NULL OR _cpf_digits = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CPF_REQUIRED');
    END IF;

    -- Basic structural check (length 11)
    IF length(_cpf_digits) != 11 OR _cpf_digits !~ '^[0-9]+$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CPF_STRUCTURE');
    END IF;

    -- Check if profile exists
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PROFILE_NOT_FOUND');
    END IF;

    -- Check for unique conflict without revealing owner
    SELECT id INTO _existing_id FROM public.profiles WHERE cpf_digits = _cpf_digits AND id != _user_id LIMIT 1;
    IF _existing_id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CPF_ALREADY_EXISTS');
    END IF;

    -- Atomic update of CPF and flag
    UPDATE public.profiles
    SET 
        cpf_digits = _cpf_digits,
        cpf_required = FALSE,
        updated_at = now()
    WHERE id = _user_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- 2. Restrict secure_set_cpf to service_role only
REVOKE EXECUTE ON FUNCTION public.secure_set_cpf(UUID, TEXT) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.secure_set_cpf(UUID, TEXT) TO service_role;

-- 3. Refactor secure_update_profile to NOT touch CPF or cpf_required
CREATE OR REPLACE FUNCTION public.secure_update_profile(
    _user_id UUID,
    _full_name TEXT,
    _phone_digits TEXT,
    _cpf_digits TEXT DEFAULT NULL -- Kept for backward compat but ignored
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Update only non-sensitive fields
    UPDATE public.profiles
    SET 
        full_name = COALESCE(_full_name, full_name),
        phone_digits = COALESCE(_phone_digits, phone_digits),
        updated_at = now()
    WHERE id = _user_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- 4. Revoke UPDATE from authenticated users on profiles table (Data API safety)
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT SELECT ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
