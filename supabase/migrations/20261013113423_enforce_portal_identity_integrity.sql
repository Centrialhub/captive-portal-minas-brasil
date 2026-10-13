-- Validate new/changed identity fields without rewriting or stranding legacy rows.
-- Unchanged historical invalid values can still receive unrelated CRM updates.
SET lock_timeout = '3s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION private.portal_cpf_valid(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog AS $$
DECLARE digits text; total int; rem int; size int; i int;
BEGIN
  IF value !~ '^[0-9.[:space:]-]*$' THEN RETURN false; END IF;
  digits := regexp_replace(value,'[^0-9]','','g');
  IF digits !~ '^[0-9]{11}$' OR digits ~ '^([0-9])\1{10}$' THEN RETURN false; END IF;
  FOR size IN 9..10 LOOP
    total := 0;
    FOR i IN 1..size LOOP total := total + substring(digits,i,1)::int*(size+2-i); END LOOP;
    rem := total % 11;
    IF substring(digits,size+1,1)::int <> (CASE WHEN rem<2 THEN 0 ELSE 11-rem END) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION private.portal_phone_normalize(value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog AS $$
DECLARE digits text; raw text;
BEGIN
  IF value !~ '^[[:space:]]*\+?[0-9()[:space:].-]*$' THEN RETURN ''; END IF;
  raw := btrim(value, E' \t\n\r');
  digits := regexp_replace(raw,'[^0-9]','','g');
  IF left(digits,2)='55' AND length(digits) IN (12,13) AND left(raw,1)<>'(' THEN RETURN substring(digits,3); END IF;
  IF left(raw,1)='+' THEN RETURN '+' || digits; END IF;
  RETURN digits;
END $$;

CREATE OR REPLACE FUNCTION private.portal_phone_valid(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog, private AS $$
DECLARE digits text := private.portal_phone_normalize(value);
BEGIN
  IF digits !~ '^[0-9]{10,11}$' THEN RETURN false; END IF;
  IF substring(digits,1,2)::int <> ALL(ARRAY[11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,51,53,54,55,61,62,63,64,65,66,67,68,69,71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,91,92,93,94,95,96,97,98,99]) THEN RETURN false; END IF;
  RETURN CASE WHEN length(digits)=11 THEN substring(digits,3,1)='9' ELSE substring(digits,3,1) ~ '^[2-5]$' END;
END $$;

CREATE OR REPLACE FUNCTION private.validate_portal_identity_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, private AS $$
DECLARE next_row jsonb := to_jsonb(NEW); prev_row jsonb; cpf_key text; phone_key text; val text;
BEGIN
  IF TG_OP='UPDATE' THEN prev_row := to_jsonb(OLD); END IF;
  cpf_key := CASE WHEN TG_TABLE_NAME='profiles' THEN 'cpf_digits' ELSE 'cpf' END;
  phone_key := CASE WHEN TG_TABLE_NAME='profiles' THEN 'phone_digits' ELSE 'phone' END;
  IF TG_OP='INSERT' OR next_row->>cpf_key IS DISTINCT FROM prev_row->>cpf_key THEN
    val := next_row->>cpf_key;
    IF nullif(val,'') IS NOT NULL AND NOT private.portal_cpf_valid(val) THEN
      RAISE EXCEPTION 'INVALID_CPF' USING ERRCODE='23514';
    END IF;
    next_row := jsonb_set(next_row,ARRAY[cpf_key],coalesce(to_jsonb(nullif(regexp_replace(val,'[^0-9]','','g'),'')),'null'::jsonb));
  END IF;
  IF TG_OP='INSERT' OR next_row->>phone_key IS DISTINCT FROM prev_row->>phone_key THEN
    val := next_row->>phone_key;
    IF nullif(val,'') IS NOT NULL AND NOT private.portal_phone_valid(val) THEN
      RAISE EXCEPTION 'INVALID_PHONE' USING ERRCODE='23514';
    END IF;
    next_row := jsonb_set(next_row,ARRAY[phone_key],coalesce(to_jsonb(nullif(private.portal_phone_normalize(val),'')),'null'::jsonb));
  END IF;
  NEW := jsonb_populate_record(NEW,next_row);
  RETURN NEW;
END $$;

CREATE TRIGGER validate_profiles_identity_write BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.validate_portal_identity_write();
CREATE TRIGGER validate_leads_identity_write BEFORE INSERT OR UPDATE ON public.leads
FOR EACH ROW EXECUTE FUNCTION private.validate_portal_identity_write();

-- Called only after the Edge Function verifies the owner's Auth access token.
-- Lock and re-check inside the transaction: a concurrent repair cannot replace
-- identifiers that became valid since the caller read the profile.
CREATE OR REPLACE FUNCTION public.repair_captive_identity(p_user_id uuid,p_cpf text,p_phone text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, private AS $$
DECLARE p public.profiles%ROWTYPE;
BEGIN
  IF NOT coalesce(private.portal_cpf_valid(p_cpf),false) OR NOT coalesce(private.portal_phone_valid(p_phone),false) THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_IDENTITY');
  END IF;
  p_cpf := regexp_replace(p_cpf,'[^0-9]','','g');
  p_phone := private.portal_phone_normalize(p_phone);
  -- Match resolve_portal_identity's lock order for rolling migration clients.
  PERFORM pg_advisory_xact_lock(hashtextextended('portal-identity-cpf:'||p_cpf,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('portal-identity-phone:'||p_phone,0));
  SELECT * INTO p FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','PROFILE_NOT_FOUND'); END IF;
  IF (coalesce(private.portal_cpf_valid(p.cpf_digits),false) AND regexp_replace(p.cpf_digits,'[^0-9]','','g')<>p_cpf)
    OR (coalesce(private.portal_phone_valid(p.phone_digits),false) AND private.portal_phone_normalize(p.phone_digits)<>p_phone) THEN
    RETURN jsonb_build_object('ok',false,'code','IDENTITY_CHANGED');
  END IF;
  IF EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=p_user_id AND role='admin') THEN
    RETURN jsonb_build_object('ok',false,'code','PRIVILEGED_ACCOUNT');
  END IF;
  UPDATE public.profiles SET cpf_digits=p_cpf,phone_digits=p_phone,cpf_required=false WHERE id=p_user_id;
  RETURN jsonb_build_object('ok',true);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok',false,'code','IDENTITY_CONFLICT');
END $$;

REVOKE ALL ON FUNCTION private.portal_cpf_valid(text),private.portal_phone_normalize(text),private.portal_phone_valid(text),private.validate_portal_identity_write(),public.repair_captive_identity(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT EXECUTE ON FUNCTION private.portal_cpf_valid(text),private.portal_phone_normalize(text),private.portal_phone_valid(text),private.validate_portal_identity_write(),public.repair_captive_identity(uuid,text,text) TO service_role;

RESET lock_timeout;
RESET statement_timeout;
