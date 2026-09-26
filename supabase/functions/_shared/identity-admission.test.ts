import fs from "node:fs";
import vm from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = fs.readFileSync(new URL("../captive-portal/index.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("edge.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["handleIdentity", "getPublicIp", "rateLimitedResponse", "sha256Hex"]);
const selected = tree.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text || ""));
if (selected.length !== names.size) throw new Error("Identity admission extraction incomplete");
const compiled = ts.transpileModule(selected.map(n => n.getText(tree)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const ATTEMPT = "12345678-1234-1234-1234-123456789012";
const TOKEN = "a".repeat(64);

function harness(reply: any, resumed = false) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => reply);
  const authorize = vi.fn(() => { throw new Error("Unexpected authorization"); });
  const handleAttemptStatus = vi.fn(async () => new Response(JSON.stringify({ processing: true })));
  const context = vm.createContext({
    Request, Response, Date, TextEncoder, crypto: webcrypto,
    Logger: { info() {}, error() {}, warn() {} },
    supabaseAdmin: () => ({ rpc }), safeParseJson: (r: Request) => r.json(), getTraceId: () => "synthetic",
    normalizeBrazilianPhone: (p: string) => p,
    Validators: { phone: () => true, cpf: () => true, ip: (ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) },
    getValidatedAuthContext: async () => ({ ctx: { clientMac: "001122334455" }, attemptId: ATTEMPT, resumeToken: TOKEN }),
    readOperation: async () => resumed ? { operation_id: "operation-test" } : {}, handleAttemptStatus,
    authorizeAuthenticatedUser: authorize,
    jsonResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
  });
  vm.runInContext(compiled, context);
  const submit = (headers: Record<string, string> = {}) => context.handleIdentity(new Request("https://portal.invalid/identify", {
    method: "POST", headers, body: JSON.stringify({ cpf: "12345678909", phone: "38999999999", client_ip: "203.0.113.200", client_mac: "AABBCCDDEEFF" }),
  })) as Promise<Response>;
  return { submit, rpc, authorize, handleAttemptStatus };
}

describe("Identity admission handler contract", () => {
  it.each([
    { data: null, error: { code: "UNAVAILABLE" } },
    { data: null, error: null },
    { data: { allowed: "true" }, error: null },
  ])("fails closed on a missing or invalid database reply", async reply => {
    const h = harness(reply), r = await h.submit();
    expect(r.status).toBe(503); expect((await r.json()).code).toBe("rate_limit_unavailable");
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("returns the database cooldown and ignores IP and MAC supplied in the body", async () => {
    const h = harness({ data: { allowed: false, blocked_until: new Date(Date.now() + 900_000).toISOString() }, error: null });
    const r = await h.submit({ "x-real-ip": "198.51.100.10" });
    expect(r.status).toBe(429); expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(899);
    expect(h.rpc).toHaveBeenCalledWith("admit_captive_identity", {
      p_attempt_id: ATTEMPT, p_resume_token: TOKEN,
      p_identity_hash: createHash("sha256").update("12345678909:38999999999").digest("hex"),
      p_origin_hash: createHash("sha256").update("198.51.100.10").digest("hex"),
    });
  });

  it("passes absent network origin explicitly without inventing a client IP", async () => {
    const h = harness({ data: { allowed: false, blocked_until: new Date().toISOString() }, error: null });
    await h.submit(); expect(h.rpc.mock.calls[0][1].p_origin_hash).toBeNull();
  });

  it("rejects capabilities invalidated during the database check", async () => {
    const h = harness({ data: { allowed: false, invalid_attempt: true }, error: null });
    const r = await h.submit(); expect(r.status).toBe(403); expect((await r.json()).code).toBe("invalid_attempt");
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("resumes an admitted capability without a new limiter debit or authorization", async () => {
    const h = harness({ data: null, error: { code: "UNAVAILABLE" } }, true);
    const r = await h.submit(); expect(r.status).toBe(200); expect(h.handleAttemptStatus).toHaveBeenCalledOnce();
    expect(h.rpc).not.toHaveBeenCalled(); expect(h.authorize).not.toHaveBeenCalled();
  });
});
