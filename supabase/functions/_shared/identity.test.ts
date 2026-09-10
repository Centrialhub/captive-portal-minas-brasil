import { describe, expect, it } from "vitest";

import { normalizeBrazilianPhone, storedPhoneMatches } from "./identity.ts";

describe("portal identity matching", () => {
  it("normalizes Brazilian country codes before comparing phones", () => {
    expect(normalizeBrazilianPhone("+55 (38) 99999-9999")).toBe("38999999999");
    expect(storedPhoneMatches("5538999999999", "(38) 99999-9999")).toBe(true);
  });

  it("rejects missing or different phones for an existing CPF", () => {
    expect(storedPhoneMatches(null, "38999999999")).toBe(false);
    expect(storedPhoneMatches("38999999999", "38988888888")).toBe(false);
  });
});
