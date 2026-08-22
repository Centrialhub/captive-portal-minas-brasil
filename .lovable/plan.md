---
title: Prompt 05 — Implement Google OAuth Callback and Redirect Standardization
description: Restores handleOAuthCallback to ensure deterministic redirection after Google login and standardizes post-auth behaviors.
---

## Implementation Plan

### Visual Documentation Update
- Update `src/routes/index.tsx` to include the verbatim Prompt 05 text.

### Edge Function Logic (Captive Portal)
- Restore the `handleOAuthCallback` function in `supabase/functions/captive-portal/index.ts`.
- Ensure it handles the Supabase OAuth hash/query params and redirects back to the portal correctly.
- Standardize the `SuccessView` and `resolvePostAuthRedirect` logic in the frontend to ensure all users see the "Wi-Fi liberado" screen.

## Technical Details
- **Route Restoration**: Re-injecting the logic that processes `code` or `access_token` from external auth providers.
- **Redirect URI**: Ensuring the `redirectTo` parameter matches the production domain `minasbrasilwifi.com.br`.
- **Validation**: Running `npm run check` to verify type safety.
