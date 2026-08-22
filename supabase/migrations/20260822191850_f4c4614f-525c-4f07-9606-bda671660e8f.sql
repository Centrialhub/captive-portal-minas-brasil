-- Fix security linter warnings for oauth attempt protection
ALTER FUNCTION public.protect_attempt_user_id() SET search_path = public;
