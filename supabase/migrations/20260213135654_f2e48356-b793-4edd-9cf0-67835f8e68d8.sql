
-- Add post_auth_redirect_url to stores
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS post_auth_redirect_url text;

COMMENT ON COLUMN public.stores.post_auth_redirect_url IS 'Override redirect URL after authorization. Falls back to global env POST_AUTH_REDIRECT_URL.';
