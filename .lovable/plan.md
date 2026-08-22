# Unified Capability Auth Flow Implementation Plan

This plan standardizes all authentication methods (Google OAuth, Email/Password, Signup) to use a unified server-side tracking mechanism via `attempt_id` and `resume_token`. This ensures transactional integrity and a consistent way to prepare the authentication context across the entire application.

## User Review Required

> [!IMPORTANT]
> All authentication methods will now require a server-side "attempt" to be initialized before completion. This ensures that captive portal parameters are preserved authoritatively on the server, not just in the client's local storage.

## Proposed Changes

### 1. OAuthTracker & API Refactoring
- **`src/lib/oauth-tracker.ts`**: Add `ensureAttempt()` to the `OAuthTracker` object. This method will check if an active attempt exists, and if not, call `initOAuthTransaction()` to create one.
- **`src/lib/api.ts`**: Update the `signup` and `login` method signatures to include optional `attempt_id` and `resume_token` fields, aligning them with the unified capability flow.

### 2. Edge Function Hardening
- **`supabase/functions/captive-portal/index.ts`**:
    - Refactor `/login` and `/signup` handlers to validate the provided `attempt_id` and `resume_token` using the existing `validateOAuthAttempt` utility.
    - Standardize the loading of captive parameters (MAC, AP, SSID) from the validated server-side attempt context instead of relying solely on frontend parameters.
    - Atomically link the newly created or authenticated `user_id` to the `captive_auth_attempts` record before proceeding to UniFi authorization.

### 3. Frontend Integration
- **`src/App.tsx`**:
    - Update `handleLogin` and `handleSignup` to call `OAuthTracker.ensureAttempt()` before sending the authentication request to the API.
    - Ensure the resulting `attempt_id` and `resume_token` are passed to the backend.

### 4. Documentation Update
- **`src/routes/index.tsx`**: Update the visual status dashboard to reflect the completion of the "Unified Capability Flow" audit.

## Technical Details

- **Capability Flow**: The `resume_token` acts as a temporary capability secret. It is hashed (SHA-256) in the database and only exists in plaintext in the client's storage/URL during the flow.
- **Race Condition Prevention**: By using server-side attempts for all methods, we leverage the existing `claim_auth_attempt` logic which uses database row-level locking (`FOR UPDATE`) to prevent concurrent UniFi authorization requests for the same attempt.
- **Recovery resilience**: If a worker crashes during authorization, the recovery logic already in place for Google OAuth will now automatically support Email/Password and Signup flows as well.
