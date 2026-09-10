// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { AttemptTracker } from "./attempt-tracker";

describe("captive attempt tracking", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, "", "/?id=AA:BB:CC:DD:EE:FF&ap=11:22:33:44:55:66&ssid=Loja");
    vi.restoreAllMocks();
  });

  it("creates one server-authoritative attempt and reuses it during the flow", async () => {
    const init = vi.spyOn(api, "initAttempt").mockResolvedValue({
      attempt_id: "be7928df-ade1-48cc-a3e9-4937c83c052b",
      token: "opaque-token",
    });

    const first = await AttemptTracker.ensureAttempt();
    const second = await AttemptTracker.ensureAttempt();

    expect(first).toEqual({
      attempt_id: "be7928df-ade1-48cc-a3e9-4937c83c052b",
      token: "opaque-token",
    });
    expect(second).toEqual(first);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ id: "AA:BB:CC:DD:EE:FF", ssid: "Loja" }),
    }));
  });

  it("clears the capability after a terminal outcome", () => {
    sessionStorage.setItem("mb_auth_attempt_id", "attempt");
    sessionStorage.setItem("mb_auth_attempt_token", "token");

    AttemptTracker.clear();

    expect(AttemptTracker.get()).toEqual({ attempt_id: null, token: null });
  });
});
