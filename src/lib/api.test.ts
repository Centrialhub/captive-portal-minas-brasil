// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, getStoreParam } from "./api";

class FakeXHR {
  static requests: FakeXHR[] = [];
  status = 200;
  responseText = "";
  timeout = 0;
  method = "";
  url = "";
  body: string | null = null;
  headers: Record<string, string> = {};
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  constructor() { FakeXHR.requests.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader() {}
  getResponseHeader(name: string) { return this.headers[name] || null; }
  send(body: string | null) { this.body = body; }
  respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.headers = headers;
    this.onload?.();
  }
}

describe("portal API", () => {
  beforeEach(() => {
    FakeXHR.requests = [];
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    window.history.replaceState(null, "", "/?store=povao");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("forwards only an explicit store", () => {
    expect(getStoreParam("?store=centro&id=client")).toBe("?store=centro");
    expect(getStoreParam("?id=client")).toBe("");
  });

  it("reads status by POST with capability only in the body", async () => {
    const promise = api.attemptStatus({ attempt_id: "synthetic", token: "test-capability" });
    const request = FakeXHR.requests[0];
    expect(request.method).toBe("POST");
    expect(request.url).toContain("route=%2Fattempt%2Fstatus");
    expect(request.url).not.toContain("test-capability");
    expect(JSON.parse(request.body!)).toEqual({ attempt_id: "synthetic", token: "test-capability" });
    request.respond(200, { authorized: true, status: "confirmed", processing: false });
    await expect(promise).resolves.toMatchObject({ authorized: true });
  });

  it.each(["<html>proxy fallback</html>", "null", "{}", '{"authorized":false}', '{"authorized":"true"}', '{"authorized":false,"status":"confirmed"}'])(
    "does not treat malformed HTTP 200 as a terminal outcome: %s", async body => {
      const promise = api.attemptStatus({ attempt_id: "synthetic", token: "test-capability" });
      FakeXHR.requests[0].respond(200, body);
      await expect(promise).rejects.toMatchObject({ kind: "parse" });
    },
  );

  it("keeps error code and the larger structured/header retry delay", async () => {
    const promise = api.initAttempt({ params: {}, original_url: "https://example.invalid/" });
    FakeXHR.requests[0].respond(429, { error: "Aguarde", code: "RATE_LIMITED", retry_after_ms: 5000 }, { "Retry-After": "12" });
    await expect(promise).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfterMs: 12000, message: "Aguarde" });
  });

  it("uses server time for dated Retry-After despite a fast client wall clock", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-25T19:00:00Z"));
    const promise = api.initAttempt({ params: {}, original_url: "https://example.invalid/" });
    FakeXHR.requests[0].respond(429, { error: "Aguarde", blocked_until: "2026-09-25T18:00:45Z" }, {
      Date: "Fri, 25 Sep 2026 18:00:00 GMT", "Retry-After": "Fri, 25 Sep 2026 18:00:30 GMT",
    });
    await expect(promise).rejects.toMatchObject({ status: 429, retryAfterMs: 45000 });
  });

  it("rejects malformed optional server time without accepting the result as success", async () => {
    const promise = api.attemptStatus({ attempt_id: "synthetic", token: "test-capability" });
    FakeXHR.requests[0].respond(200, { authorized: true, status: "confirmed", server_now: "invalid" });
    await expect(promise).rejects.toMatchObject({ kind: "parse" });
  });

  it.each(["onabort", "onerror", "ontimeout"] as const)("settles a request on %s without inventing HTTP status", async event => {
    const promise = api.attemptStatus({ attempt_id: "synthetic", token: "test-capability" });
    FakeXHR.requests[0][event]?.();
    await expect(promise).rejects.toMatchObject({ kind: event === "onabort" ? "abort" : event === "onerror" ? "network" : "timeout", status: undefined });
  });

  it("requires server expiry for a new capability", async () => {
    const promise = api.initAttempt({ params: {}, original_url: "https://example.invalid/" });
    FakeXHR.requests[0].respond(200, { attempt_id: "synthetic", token: "test-capability" });
    await expect(promise).rejects.toMatchObject({ kind: "parse" });
  });
});
