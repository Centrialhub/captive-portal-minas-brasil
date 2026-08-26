import { describe, expect, it } from "vitest";
import {
  extractCsrfFromToken,
  isLikelyExpiredSessionResponse,
  mergeSetCookieValues,
  serializeCookieJar,
  splitCombinedSetCookie,
} from "./unifi-cookie";

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
});
