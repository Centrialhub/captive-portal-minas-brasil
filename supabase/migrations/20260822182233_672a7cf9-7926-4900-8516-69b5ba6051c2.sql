-- Revoke direct modification permissions on public.profiles to prevent bypass
REVOKE INSERT, UPDATE ON public.profiles FROM anon, authenticated;

-- Ensure authenticated users can still SELECT their own profile (controlled by RLS)
GRANT SELECT ON public.profiles TO authenticated;

-- Ensure service_role maintains full access for backend operations
GRANT ALL ON public.profiles TO service_role;