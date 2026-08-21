# Refactor Post-Auth Redirection

Standardize the redirection logic after successful Wi-Fi authorization. Ensure a deterministic, safe, and user-friendly experience that prevents loops and unauthorized destinations.

## User Review Required

> [!IMPORTANT]
> The success screen will now show a clear "Wi-Fi access released" message with a 2-second countdown before automatically redirecting. A manual "Continue now" button will also be available.

- **Deterministic Redirect**: The app will strictly follow a priority list for the final destination.
- **Enhanced Security**: Any destination that points back to the portal, the controller, raw IPs, or Supabase will be blocked and replaced with the corporate site.
- **Visual Feedback**: Users will see a clear confirmation before being navigated away, improving the experience in Captive Network Assistants.

## Proposed Changes

### Frontend

#### `src/lib/portal-utils.ts`
- Implement `resolvePostAuthRedirect(backendUrl, captiveUrl)`:
    - Priority 1: Backend `redirect_url`.
    - Priority 2: Original captive `url` parameter.
    - Fallback: `https://www.drogariaminasbrasil.com.br/`.
    - Apply a strict blocklist (IPs, portal host, controller host, Supabase, non-standard ports).
- Update `sanitizeCaptiveRedirect` to use this new centralized logic.

#### `src/App.tsx`
- Refactor `completeAuthenticatedSession` and `handleLogin`/`handleSignup` to use the new redirection flow.
- Update the `success` step UI:
    - Add "Redirecionando em 2 segundos..." text.
    - Implement a 2-second timer using `useEffect`.
    - Ensure `window.location.replace` is used to prevent "Back" button loops.
    - Clean up OAuth markers and captive parameters only after successful authorization and redirect resolution.

### Backend (Edge Function)

#### `supabase/functions/captive-portal/index.ts`
- Update `DEFAULT_REDIRECT_URL` to use `https://` if it's currently using `http://`.

## Technical Details

- **Navigation**: Using `location.replace()` instead of `location.href` is critical to remove the portal from the browser history, preventing loops if the user clicks the back button.
- **Safety Matrix**:
    - Rejects: `minasbrasilwifi.com.br`, `31.97.170.23`, `187.77.48.59`, `rwificontroller`, `*.supabase.co`, `javascript:`, etc.
    - Allowed: Any valid HTTPS URL that is not on the blocklist.
- **Timer Management**: Timers will be properly cleared on component unmount to prevent memory leaks or concurrent redirection attempts.
