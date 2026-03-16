

# Fix: Validate UniFi authorize response body

## Problem
The edge function checks only `res.ok` (HTTP status 200) when authorizing a guest on the UniFi controller. However, UniFi returns HTTP 200 even for errors, with the actual status in the JSON body:
```json
{"meta":{"rc":"ok"},"data":[]}     // success
{"meta":{"rc":"error","msg":"..."}} // failure (still HTTP 200!)
```

The current code (line 601-603) sees HTTP 200 and immediately returns `{ ok: true }` without checking `rc`. This explains why the portal shows "Conectado!" but the internet doesn't work — the controller rejected the authorization but the code didn't notice.

Additionally, the successful response body is never logged, making debugging impossible.

## Fix (edge function)

### File: `supabase/functions/captive-portal/index.ts` (lines 600-603)

Replace the simple `res.ok` check with proper JSON body validation:

```typescript
const resText = await res.text();
if (res.ok) {
  // Log the response for debugging
  console.log(`UniFi authorize response from ${url}: ${resText.slice(0, 300)}`);
  
  // UniFi returns 200 even for errors — check rc field
  try {
    const resJson = JSON.parse(resText);
    if (resJson?.meta?.rc === "error") {
      lastError = `UniFi rejected: ${resJson.meta.msg || "unknown error"}`;
      console.warn(lastError);
      continue; // try next URL if available
    }
  } catch {
    // Not JSON — treat HTTP 200 as success
  }
  
  console.log(`UniFi authorize succeeded via ${url}`);
  return { ok: true };
}
```

This single change will:
1. **Log the actual response** from the controller on every attempt
2. **Detect `rc: "error"` responses** that come with HTTP 200
3. **Try the next URL** if available (e.g., OS path vs legacy path)
4. **Return accurate `ok: false`** so the frontend shows the real error instead of fake success

After deploying, the next test will show in the edge function logs exactly what the controller returned, making it easy to diagnose the root cause (wrong MAC format, wrong site, permissions, etc.).

