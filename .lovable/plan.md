# Plan: Fix Certificate Errors in Captive Portal Redirects

The user reports certificate errors when being redirected to the captive portal at IP `187.77.48.59`. This usually happens because the redirection (302) is pointing to an HTTPS URL while the client is not yet authorized or the browser doesn't trust the IP-based certificate.

## Proposed Changes

### 1. Nginx Configuration (Dockerfile)
- Update Nginx configuration in the `Dockerfile` to ensure redirects use the plain HTTP protocol when appropriate.
- Verify that the `minasbrasilwifi.com.br` domain is used consistently.
- Add `server_name` explicitly for both the domain and the IP to help with certificate matching if needed, though for captive portals, forcing HTTP for the initial splash is often the most reliable path.

### 2. Frontend Redirect Logic
- In `src/lib/portal-utils.ts` and `index.html`, review the `sanitizeCaptiveRedirect` logic.
- Ensure that we are not accidentally forcing HTTPS redirects for the initial portal splash which might trigger certificate warnings on devices before they are authenticated.

### 3. Backend Verification
- Ensure that the `captive-portal` Edge Function correctly handles the `redirect_url` and doesn't inject HTTPS where it's not supported by the controller's current state.

## Technical Details
- **Protocol Management**: We will ensure the `302` redirect from Nginx uses `http://` instead of `https://` for the initial landing if it's detected that the device is in a pre-auth state, as this is the primary cause of "Certificate Error" screens in iOS/Android CNA.
- **Walled Garden**: Remind the user that the IP `187.77.48.59` and domain `minasbrasilwifi.com.br` MUST be in the Walled Garden, but they should be accessible over HTTP.
