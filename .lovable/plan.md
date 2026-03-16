

# Fix: Increase timeout for verify-code requests

## Problem
The `/verify-code` endpoint takes ~9 seconds because it sequentially:
1. Validates OTP hash
2. Logs into UniFi controller (tries OS endpoint, gets 401, falls back to legacy)
3. Sends authorize-guest command

The frontend `resilientFetch` has an 8-second timeout, so the response arrives after the client has already aborted the request. The backend succeeds (session marked `authorized` in DB) but the user sees "Erro ao verificar código."

## Solution
Increase the timeout in `resilientFetch` for the `verify-code` call. The simplest approach: increase the default timeout from 8s to 15s, since all API calls benefit from more tolerance (captive portal environments have unreliable networks).

### File: `src/lib/api.ts`
- Change default `timeoutMs` from `8000` to `15000` in `resilientFetch`

This single change fixes the issue without any backend modifications.

