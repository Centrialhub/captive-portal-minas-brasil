-- Drop the overly permissive policy that exposes sensitive columns to all authenticated users
DROP POLICY IF EXISTS "Authenticated read basic store info" ON public.stores;

-- Create admin-only SELECT policy
CREATE POLICY "Admin can read stores"
  ON public.stores
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
