export type UnifiCookieJar = Record<string, string>;

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

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
  for (const value of values) {
    const pair = value.split(";", 1)[0]?.trim() || "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (!COOKIE_NAME.test(name)) continue;
    if (!cookieValue) delete next[name];
    else next[name] = cookieValue;
  }
  return next;
}

export function mergeResponseCookies(
  current: UnifiCookieJar,
  headers: Headers,
): UnifiCookieJar {
  return mergeSetCookieValues(current, getSetCookieValues(headers));
}

export function serializeCookieJar(jar: UnifiCookieJar): string {
  return Object.entries(jar)
    .filter(([name, value]) => COOKIE_NAME.test(name) && value.length > 0)
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
