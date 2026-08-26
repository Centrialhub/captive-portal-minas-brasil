-- Consolidate equivalent SELECT policies to avoid duplicate policy evaluation.
DROP POLICY IF EXISTS "Users can read own sessions" ON public.captive_sessions;
DROP POLICY IF EXISTS "Admins can read sessions" ON public.captive_sessions;

CREATE POLICY "Authenticated users can read permitted sessions"
ON public.captive_sessions
FOR SELECT
TO authenticated
USING (
  (SELECT auth.uid()) = user_id
  OR (SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role))
);

DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admins can read profiles" ON public.profiles;

CREATE POLICY "Authenticated users can read permitted profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  (SELECT auth.uid()) = id
  OR (SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role))
);
