import { describe, expect, it } from "vitest";
import {
  PUBLIC_CAPTIVE_BASE_URL,
  Validators,
  isSafeRedirect,
  resolvePostAuthRedirect,
} from "./lib/portal-utils";
import { getAuthFailureMessage, isRecoverableAuthResult } from "./lib/auth-outcome";

describe("Brazilian identity validation", () => {
  it("rejects repeated or invalid CPFs and accepts a valid checksum", () => {
    expect(Validators.cpf("000.000.000-00")).toBe(false);
    expect(Validators.cpf("123.456.789-00")).toBe(false);
    expect(Validators.cpf("529.982.247-25")).toBe(true);
  });

  it("validates DDD and mobile/fixed-line structure", () => {
    expect(Validators.phone("(38) 99999-9999")).toBe(true);
    expect(Validators.phone("+55 31 3333-4444")).toBe(true);
    expect(Validators.phone("(20) 99999-9999")).toBe(false);
    expect(Validators.phone("(31) 19999-9999")).toBe(false);
  });
});

describe("post-authorization redirect safety", () => {
  it("uses the canonical HTTPS origin constant", () => {
    expect(PUBLIC_CAPTIVE_BASE_URL).toBe("https://minasbrasilwifi.com.br");
  });

  it.each([
    ["https://www.drogariaminasbrasil.com.br/ofertas", true],
    ["https://187.77.48.59/guest/s/default", false],
    ["https://controller.local/guest/s/default", false],
    ["https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/x", false],
    ["javascript:alert(1)", false],
    ["data:text/html,test", false],
    ["https://example.com:8443/path", false],
  ])("classifies %s", (url, expected) => {
    expect(isSafeRedirect(url)).toBe(expected);
  });

  it("prefers a safe backend destination and falls back safely", () => {
    expect(resolvePostAuthRedirect("https://example.com/a", "https://example.org/b"))
      .toBe("https://example.com/a");
    expect(resolvePostAuthRedirect("https://187.77.48.59", "javascript:alert(1)"))
      .toBe("https://www.drogariaminasbrasil.com.br/");
  });
});

describe("authorization outcomes", () => {
  it("keeps ambiguous/processing attempts available for recovery", () => {
    expect(isRecoverableAuthResult({ processing: true })).toBe(true);
    expect(isRecoverableAuthResult({ fail_reason: "RETRY_REQUIRED" })).toBe(true);
    expect(getAuthFailureMessage({ fail_reason: "PROCESSING_IN_PROGRESS" }))
      .toContain("ainda está sendo confirmada");
  });

  it("treats definitive failures as terminal", () => {
    expect(isRecoverableAuthResult({ fail_reason: "UNIFI_ERROR" })).toBe(false);
  });
});
