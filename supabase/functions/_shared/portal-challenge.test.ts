import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const source = fs.readFileSync(new URL("../captive-portal/index.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("edge.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["claimPortalSessionChallenge", "boundedPortalSessionChallenge", "createPortalSessionChallenge"]);
const nodes = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text || ""));
if (nodes.length !== names.size) throw new Error("Challenge extraction incomplete");
const compiled = ts.transpileModule(nodes.map(node => node.getText(tree)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const origin = Date.parse("2026-09-25T12:00:00Z");
const user = { data: { user: { email: "synthetic@example.test" } }, error: null };
const link = { data: { properties: { hashed_token: "synthetic-one-use-hash" } }, error: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  const rpc = vi.fn(async () => ({ data: "synthetic-user", error: null }));
  const getUserById = vi.fn(async () => user);
  const generateLink = vi.fn(async () => link);
  const updateUserById = vi.fn(async () => ({ error: null }));
  const db = { rpc, auth: { admin: { getUserById, generateLink, updateUserById } } };
  const context = vm.createContext({ Date, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "synthetic-id" }, Logger: { error() {} },
    PORTAL_IDENTITY_EMAIL_DOMAIN: "example.test" });
  vm.runInContext(compiled, context);
  return { rpc, getUserById, generateLink, updateUserById,
    run: () => context.claimPortalSessionChallenge(db, "synthetic-attempt", "synthetic-token") as Promise<{ token_hash: string } | null> };
}

describe("one absolute budget for optional browser login", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(origin); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns the challenge when claim and Auth complete within the shared budget", async () => {
    const h = harness();
    expect(await h.run()).toEqual({ token_hash: "synthetic-one-use-hash" });
    expect(h.generateLink).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts Auth if the optional database claim resolves after timeout", async () => {
    const h = harness(), claim = deferred<{ data: string; error: null }>();
    h.rpc.mockReturnValueOnce(claim.promise);
    const result = h.run();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toBeNull();
    claim.resolve({ data: "synthetic-user", error: null });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.getUserById).not.toHaveBeenCalled();
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it("uses only the remainder after claiming and prevents a late Auth lookup from minting", async () => {
    const h = harness(), lookup = deferred<typeof user>();
    h.rpc.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return { data: "synthetic-user", error: null };
    });
    h.getUserById.mockReturnValueOnce(lookup.promise);
    const result = h.run();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toBeNull();
    lookup.resolve(user);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.getUserById).toHaveBeenCalledTimes(1);
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it("rejects a token received after the deadline even before the overdue timer executes", async () => {
    const h = harness();
    h.generateLink.mockImplementationOnce(async () => { vi.setSystemTime(origin + 1501); return link; });
    expect(await h.run()).toBeNull();
    expect(h.generateLink).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait for an already-started Auth request or start a second mint after timeout", async () => {
    const h = harness(), mint = deferred<typeof link>();
    h.generateLink.mockReturnValueOnce(mint.promise);
    const result = h.run();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toBeNull();
    mint.resolve(link);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.generateLink).toHaveBeenCalledTimes(1);
  });
});
