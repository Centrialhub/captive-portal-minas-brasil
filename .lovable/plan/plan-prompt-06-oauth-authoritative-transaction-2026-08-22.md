# Plan - PROMPT 06: OAuth Authoritative Transaction

Replace the client-side `localStorage` based OAuth tracking with a secure, server-side authoritative transaction system to prevent parameter contamination and ensure session integrity.

## User Review Required

> [!IMPORTANT]
> The `redirectTo` in Supabase Google Auth will now include an `attempt_id` and a `token`. Ensure these parameters are allowed in the Google Cloud Console redirect URI if there are strict patterns (though usually wildcard paths or matching base domains are used).

- **Security**: MAC addresses and other PII will no longer be passed in the OAuth redirect URL.
- **Persistence**: Captive parameters will be stored in the database and retrieved only with a valid, non-expired, non-consumed token.

## Proposed Changes

### Database Schema
- Create `public.captive_auth_attempts` table.
- Implement RLS: `anon` can insert (rate-limited), `service_role` can manage.
- Add `resume_token_hash` for secure lookup.

### Edge Function (`supabase/functions/captive-portal/index.ts`)
- **New endpoint `/oauth/init`**:
  - Validates captive parameters from request.
  - Generates a cryptographically strong `resume_token`.
  - Stores hash in DB and returns `attempt_id` + `token`.
- **Refactor `handleOAuthCallback`**:
  - Validates `attempt_id` and `token` against the DB.
  - Ensures the attempt is not expired or consumed.
  - Redirects to React portal with `attempt_id` and `token` in the fragment/query.
- **Refactor `authorizeExisting`**:
  - Accepts `attempt_id` and `token`.
  - Loads parameters authoritative from `captive_auth_attempts`.
  - Marks attempt as `consumed` upon successful authorization.

### Frontend
- **Refactor `OAuthTracker` (`src/lib/oauth-tracker.ts`)**:
  - Replaces `stashCaptiveParams` with a call to `/oauth/init`.
  - Stores only `attempt_id` and `token` in `localStorage` as a temporary cache.
  - `restoreCaptiveParams` now just ensures the URL has the token for recovery.
- **Update `App.tsx`**:
  - Modifies `handleGoogleOAuth` to initialize the transaction first.
  - Updates `completeAuthenticatedSession` to pass the transaction tokens to the backend.
- **Update `api.ts`**:
  - Adds `initOAuth` method.
  - Updates `authorizeExisting` signature.

## Technical Details
- **Token Hashing**: Tokens are hashed using SHA-256 before storage.
- **State Machine**: Implement explicit statuses (`created`, `redirected`, `callback`, `authorizing`, `authorized`, `failed`, `expired`).
- **Rate Limiting**: `/oauth/init` will be rate-limited by MAC and IP.

## Verification Plan

### Automated Tests
- `npm run check` for type safety.
- Test endpoint `/oauth/init` with valid/invalid parameters.
- Test `/oauth/callback` with correct/incorrect tokens.

### Manual Verification
1. Open captive portal.
2. Click "Login with Google".
3. Verify URL redirection contains only opaque tokens.
4. Complete Google login.
5. Verify successful authorization and MAC release.
6. Attempt to reuse the same OAuth callback URL and verify rejection.
