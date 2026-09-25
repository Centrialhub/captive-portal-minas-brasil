export type UnifiCookieJar = Record<string, string>;

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Retain the public name/value shape while carrying expiry through jar merges.
// Entries are request-local and disappear when their jar is collected.
const cookieExpiries = new WeakMap<UnifiCookieJar, Map<string, number>>();

/**
 * Headers.get("set-cookie") may combine multiple Set-Cookie fields. Split only
 * at commas that introduce another cookie, preserving commas inside Expires.
 */
export function splitCombinedSetCookie(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/g)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

export function getSetCookieValues(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === "function") {
    const values = extended.getSetCookie.call(headers);
    if (values.length) return values;
  }
  return splitCombinedSetCookie(headers.get("set-cookie") || "");
}

export function mergeSetCookieValues(
  current: UnifiCookieJar,
  values: string[],
): UnifiCookieJar {
  const next = { ...current };
  const now = Date.now();
  const expiries = new Map(cookieExpiries.get(current));
  for (const [name, expiresAt] of expiries) {
    if (expiresAt <= now) { delete next[name]; expiries.delete(name); }
  }
  for (const value of values) {
    const [rawPair, ...attributes] = value.split(";");
    const pair = rawPair?.trim() || "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (!COOKIE_NAME.test(name)) continue;
    let maxAge: number | undefined;
    let expires: number | undefined;
    for (const attribute of attributes) {
      const separator = attribute.indexOf("=");
      if (separator < 0) continue;
      const key = attribute.slice(0, separator).trim().toLowerCase();
      const content = attribute.slice(separator + 1).trim();
      // RFC 6265 5.2.2: invalid Max-Age is ignored, allowing Expires to apply.
      if (key === "max-age" && /^-?\d+$/.test(content)) maxAge = Number(content);
      if (key === "expires") {
        const parsed = Date.parse(content);
        if (Number.isFinite(parsed)) expires = parsed;
      }
    }
    // RFC 6265 5.3: the last valid Max-Age takes precedence over Expires.
    const expiresAt = maxAge !== undefined ? (maxAge <= 0 ? -Infinity : now + maxAge * 1000) : expires;
    if (!cookieValue || (expiresAt !== undefined && expiresAt <= now)) {
      delete next[name]; expiries.delete(name);
    } else {
      next[name] = cookieValue;
      if (expiresAt === undefined) expiries.delete(name);
      else expiries.set(name, expiresAt);
    }
  }
  cookieExpiries.set(next, expiries);
  return next;
}

export function mergeResponseCookies(
  current: UnifiCookieJar,
  headers: Headers,
): UnifiCookieJar {
  return mergeSetCookieValues(current, getSetCookieValues(headers));
}

export function serializeCookieJar(jar: UnifiCookieJar): string {
  const expiries = cookieExpiries.get(jar);
  const now = Date.now();
  return Object.entries(jar)
    .filter(([name, value]) => COOKIE_NAME.test(name) && value.length > 0 && (expiries?.get(name) ?? Infinity) > now)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return atob(padded);
}

/** UniFi OS JWTs carry their actual CSRF value in the token payload. */
export function extractCsrfFromToken(token: string): string | null {
  try {
    const payload = decodeURIComponent(token).split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(decodeBase64Url(payload)) as Record<string, unknown>;
    const csrf = decoded.csrfToken ?? decoded.csrf_token ?? decoded.csrf;
    return typeof csrf === "string" && csrf ? csrf : null;
  } catch {
    return null;
  }
}

export function isLikelyExpiredSessionResponse(status: number, isJson: boolean): boolean {
  return status === 401 || status === 403 ||
    (status >= 300 && status < 400) ||
    (status >= 200 && status < 300 && !isJson);
}
