-- Forward-only policy change requested by the portal owner. No legacy rows
-- are rewritten; existing triggers validate only new/changed values.
SET lock_timeout = '3s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION private.portal_phone_valid(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog, private AS $$
DECLARE digits text := private.portal_phone_normalize(value); subscriber text;
BEGIN
  IF digits !~ '^[0-9]{10,11}$' THEN RETURN false; END IF;
  IF substring(digits,1,2)::int <> ALL(ARRAY[11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,51,53,54,55,61,62,63,64,65,66,67,68,69,71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,91,92,93,94,95,96,97,98,99]) THEN RETURN false; END IF;
  subscriber := substring(digits,3);
  IF subscriber = '912345678' THEN RETURN false; END IF;
  IF subscriber ~ '^([0-9])\1+$' OR (length(digits)=11 AND substring(subscriber,2) ~ '^([0-9])\1{7}$') THEN RETURN false; END IF;
  RETURN CASE WHEN length(digits)=11 THEN substring(digits,3,1)='9' ELSE substring(digits,3,1) ~ '^[2-5]$' END;
END $$;

REVOKE ALL ON FUNCTION private.portal_phone_valid(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.portal_phone_valid(text) TO service_role;

RESET lock_timeout;
RESET statement_timeout;
