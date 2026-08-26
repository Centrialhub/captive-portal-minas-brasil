import { describe, expect, it } from "vitest";

import { getStoreParam } from "./api";

describe("getStoreParam", () => {
  it("forwards an explicitly configured store", () => {
    expect(getStoreParam("?store=centro&id=client")).toBe("?store=centro");
  });

  it("does not force matriz for generic captive portal parameters", () => {
    expect(getStoreParam("?id=aa:bb:cc:dd:ee:ff&mac=11:22:33:44:55:66")).toBe("");
  });
});
