# Mandatory CPF Gate for Google OAuth

Implement a mandatory CPF collection step for users authenticating via Google OAuth who do not yet have a valid CPF persisted in their profile. The Wi-Fi access will only be granted after the CPF is successfully collected and verified.

## User Review Required

> [!IMPORTANT]
> This change introduces a new "CPF Prompt" screen that will appear for all Google users on their first access.

- **Mandatory CPF**: Google users must now provide a CPF.
- **Validation**: CPFs will be validated using the official algorithm (11 digits, checksum verification).
- **Duplicate Prevention**: If a CPF is already linked to another account, the system will prevent the update and show an error.

## Proposed Changes

### Backend (Edge Functions)

#### `supabase/functions/captive-portal/index.ts`
- **`handleAuthorizeExisting`**:
    - Update selection to include `cpf_required` from the `profiles` table.
    - When auto-provisioning a new social profile, set `cpf_required: true`.
    - Block UniFi authorization if `authMethod === "google"` and CPF is missing or `cpf_required` is true.
    - Return a specific JSON response `{ needs_cpf: true, ... }` to the frontend when the gate is triggered.
- **`handleUpdateProfile`**:
    - Ensure `cpf_required` is set to `false` when a valid CPF is updated.
    - Handle database unique constraint violations (CPF already in use) with a user-friendly error message.

### Frontend (React)

#### `src/App.tsx`
- **New Step**: Added `cpf_prompt` to the state machine.
- **CPF Prompt UI**:
    - Displays the user's Google account info (name/email).
    - Includes a masked CPF input field (`000.000.000-00`).
    - Provides a "Save CPF and Release Wi-Fi" button.
    - Provides a "Use another account" button to restart the OAuth flow.
- **Logic**:
    - `handleCpfSubmit`: Validates CPF locally, calls `api.updateProfile`, then re-triggers `api.authorizeExisting`.
    - Prevents double-submissions and handles API errors (like duplicate CPF).

#### `src/lib/portal-utils.ts`
- Ensure `isValidCPF` correctly rejects sequences of identical digits.

## Technical Details

- **Database**: Reuses the existing `profiles.cpf_digits` and `profiles.cpf_required` columns.
- **Security**: CPF is never logged or exposed in URLs. Only masked values appear in the UI.
- **Persistence**: Captive parameters (MAC, SSID, etc.) are preserved in `localStorage` throughout the CPF gate flow.
- **Idempotency**: The frontend uses `authCompletedRef` and `processingAuthRef` to ensure only one authorization attempt happens at a time.

### API Contract (needs_cpf)
```json
{
  "needs_cpf": true,
  "authorized": false,
  "auth_method": "google",
  "profile": {
    "full_name": "User Name",
    "email": "user@example.com"
  },
  "trace_id": "..."
}
```
