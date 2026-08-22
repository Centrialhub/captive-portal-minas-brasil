# Plan - Code Quality and Auth Refinement

Refine the project code for clarity, organization, and elimination of duplications, while improving the authentication flow resilience within existing boundaries.

## 1. Backend Refinement (Supabase Edge Function)
- **Organization**: Group internal helpers (Validators, UniFi Helpers, Store Detection) into logical sections with clear headers.
- **Deduplication**: Standardize input sanitization and validation.
- **Auth Resilience**: 
    - Consolidate rate limiting logic for authentication paths.
    - Ensure consistent use of `extractAuthContext`.
    - Refine `handleAuthorizeExisting` to be more descriptive in its error reporting for silent login failures.

## 2. Frontend Refinement
- **Validation**: Synchronize validation logic between `src/lib/portal-utils.ts` and the backend.
- **Component Organization**: 
    - Refactor `src/App.tsx` to simplify its main `useEffect` and consolidate redundant auth logic.
    - Improve error handling consistency in the login/signup forms.

## Technical Details
### `supabase/functions/captive-portal/index.ts`
- Move all validator functions to a single block at the top.
- Refactor `isValidPhone` for better readability.
- Add a helper for generic authentication error responses to reduce duplication in handlers.

### `src/App.tsx`
- Extract form validation logic into a helper.
- Consolidate the "post-auth" logic (setting session, authorizing UniFi, redirecting) into a single function to avoid repetition in `handleLogin` and `handleSignup`.

### `src/lib/portal-utils.ts`
- Ensure `isValidCPF` matches the backend implementation exactly.
