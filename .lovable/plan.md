

## Diagnosis

The user's three concerns map to concrete issues in the current codebase:

1. **SPA routing is already disabled** -- no react-router, `vercel.json` catch-all serves `index.html`. This is already correct.

2. **ES6+ syntax compatibility** -- Vite's default build target is `esnext`/modern. The Android Captive Assistant uses a limited WebView that may choke on optional chaining (`?.`), nullish coalescing (`??`), or other modern syntax. The React bundle currently has **no legacy transpilation target** configured.

3. **HTTPS/Walled Garden** -- This is a UniFi controller configuration issue, not a code issue. However, we should document what domains need to be in the Walled Garden.

## Plan

### 1. Configure Vite build target for legacy browser compatibility

**File: `vite.config.ts`**

Add `build.target: 'es2015'` to force Vite to transpile all output JS to ES2015 (no optional chaining, no nullish coalescing, no top-level await). This ensures the React bundle works in the limited Android Captive Assistant WebView.

```ts
build: {
  target: 'es2015',
},
```

This is the most impactful change -- it directly addresses the "blank screen" issue where modern JS syntax crashes the WebView silently.

### 2. Slim down `tailwind.config.ts`

The current config has sidebar colors, accordion animations, radix references -- all remnants of a larger SPA. These are unused in a captive portal. Simplify to only what's actually used: brand colors and basic theme. This reduces CSS bundle size and removes the `tailwindcss-animate` dependency (which was already causing build issues).

**File: `tailwind.config.ts`** -- strip to minimal config, remove `require("tailwindcss-animate")` plugin.

**File: `package.json`** -- remove `tailwindcss-animate` from dependencies.

### 3. Add Walled Garden documentation

**File: `README.md`** -- Add a section documenting the required Walled Garden entries for UniFi:
- `wifi.guedesepaixao.com.br` (portal domain)
- `fqamejlyytrhovawgtwg.supabase.co` (API backend)
- Vercel CDN IPs / `*.vercel.app` if applicable
- OCSP domains for SSL validation

### Summary of changes

| File | Change |
|---|---|
| `vite.config.ts` | Add `build.target: 'es2015'` |
| `tailwind.config.ts` | Strip unused theme config, remove `tailwindcss-animate` plugin |
| `package.json` | Remove `tailwindcss-animate` dependency |
| `README.md` | Add Walled Garden documentation |

No changes to: `index.html`, `App.tsx`, `main.tsx`, `api.ts`, `portal-utils.ts`, `vercel.json`, backend.

