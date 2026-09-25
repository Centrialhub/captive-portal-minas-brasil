import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractCsrfFromToken,
  isLikelyExpiredSessionResponse,
  mergeSetCookieValues,
  serializeCookieJar,
  splitCombinedSetCookie,
} from "./unifi-cookie";

afterEach(() => vi.useRealTimers());

describe("UniFi cookie contract", () => {
  it("preserves Expires commas while splitting multiple cookies", () => {
    const values = splitCombinedSetCookie(
      "unifi_controller=matriz; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, unifises=session==; HttpOnly; Path=/, csrf_token=csrf-value; Path=/",
    );
    expect(values).toHaveLength(3);
    const jar = mergeSetCookieValues({}, values);
    expect(jar).toEqual({
      unifi_controller: "matriz",
      unifises: "session==",
      csrf_token: "csrf-value",
    });
    expect(serializeCookieJar(jar)).toBe(
      "unifi_controller=matriz; unifises=session==; csrf_token=csrf-value",
    );
  });

  it("updates cookies without discarding the proxy routing cookie", () => {
    const warm = mergeSetCookieValues({}, ["unifi_controller=major; Path=/"]);
    const authenticated = mergeSetCookieValues(warm, ["unifises=auth-cookie; HttpOnly"]);
    expect(authenticated).toEqual({
      unifi_controller: "major",
      unifises: "auth-cookie",
    });
  });

  it("extracts the CSRF claim from a UniFi OS JWT", () => {
    const payload = btoa(JSON.stringify({ csrfToken: "real-csrf" }))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(extractCsrfFromToken(`header.${payload}.signature`)).toBe("real-csrf");
    expect(extractCsrfFromToken(encodeURIComponent(`header.${payload}.signature`))).toBe("real-csrf");
    expect(extractCsrfFromToken("not-a-jwt")).toBeNull();
  });

  it("classifies authentication redirects and denials as expired sessions", () => {
    expect(isLikelyExpiredSessionResponse(302, false)).toBe(true);
    expect(isLikelyExpiredSessionResponse(401, true)).toBe(true);
    expect(isLikelyExpiredSessionResponse(403, false)).toBe(true);
    expect(isLikelyExpiredSessionResponse(404, false)).toBe(false);
    expect(isLikelyExpiredSessionResponse(502, false)).toBe(false);
  });

  it.each([
    { attributes: "Max-Age=0; Expires=Thu, 01 Jan 2099 00:00:00 GMT", retained: false },
    { attributes: "Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT", retained: true },
    { attributes: "Max-Age=invalid; Expires=Thu, 01 Jan 1970 00:00:00 GMT", retained: false },
    { attributes: "Max-Age=60; Max-Age=invalid; Expires=Thu, 01 Jan 1970 00:00:00 GMT", retained: true },
    { attributes: "Max-Age=60; Max-Age=0", retained: false },
    { attributes: "mAx-AgE=-1", retained: false },
    { attributes: "Expires=not-a-date", retained: true },
  ])("applies valid expiry attributes and Max-Age precedence: $attributes", ({ attributes, retained }) => {
    const jar = mergeSetCookieValues({ unifises: "old", unifi_controller: "povao" }, [`unifises=new; ${attributes}`]);
    expect(jar.unifises).toBe(retained ? "new" : undefined);
    expect(jar.unifi_controller).toBe("povao");
  });

  it("stops serializing a cookie when its future lifetime ends and carries expiry across merges", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-09-25T00:00:00Z"));
    const first = mergeSetCookieValues({}, ["unifises=short-lived; Max-Age=1", "unifi_controller=povao"]);
    const merged = mergeSetCookieValues(first, ["csrf_token=csrf"]);
    expect(serializeCookieJar(merged)).toContain("unifises=short-lived");
    await vi.advanceTimersByTimeAsync(1000);
    expect(serializeCookieJar(merged)).toBe("unifi_controller=povao; csrf_token=csrf");
    const expired = mergeSetCookieValues(merged, []);
    expect(expired.unifises).toBeUndefined();
    const renewed = mergeSetCookieValues(merged, ["unifises=renewed-session"]);
    expect(serializeCookieJar(renewed)).toContain("unifises=renewed-session");
  });
});
