// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import { api, ApiError } from "./lib/api";
import { AttemptTracker } from "./lib/attempt-tracker";
import { Validators } from "./lib/portal-utils";
import { supabase } from "./integrations/supabase/client";

vi.mock("./integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), verifyOtp: vi.fn() } },
}));
vi.mock("./lib/api", async importOriginal => ({
  ...await importOriginal<typeof import("./lib/api")>(),
  api: { bootstrap: vi.fn(), identify: vi.fn(), authorizeExisting: vi.fn(), initAttempt: vi.fn(), attemptStatus: vi.fn(), clientEvent: vi.fn() },
}));

const pending = () => ({ authorized: false, processing: true, status: "verifying" as const, retry_after_ms: 1000 });
const capability = () => ({
  attempt_id: "8b5fa135-e25f-410f-a3e5-a974fc2bfc00", token: "synthetic-capability-no-authority",
  server_now: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(),
});
function renderPortal() { return render(<MemoryRouter><App /></MemoryRouter>); }
async function flush() { await act(async () => {}); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function submit(phone = "38999999999") {
  fireEvent.change(screen.getByLabelText("Telefone"), { target: { value: phone } });
  fireEvent.change(screen.getByLabelText("CPF"), { target: { value: "52998224725" } });
  fireEvent.click(screen.getByRole("button", { name: "Liberar Wi-Fi" }));
  await flush();
}

describe("post-release audit 20260926: identity formatting and restored cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-26T17:30:00Z");
    vi.resetAllMocks();
    AttemptTracker.clear(true);
    sessionStorage.clear();
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:01&ap=02:00:00:00:00:11&ssid=TEST&t=1");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.mocked(api.bootstrap).mockResolvedValue({ store: { slug: "povao", name: "Unidade sintética" }, consent: null });
    vi.mocked(api.initAttempt).mockImplementation(async () => capability());
    vi.mocked(api.identify).mockResolvedValue(pending());
    vi.mocked(api.attemptStatus).mockResolvedValue(pending());
    vi.mocked(api.authorizeExisting).mockResolvedValue(pending());
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null });
  });
  afterEach(() => {
    cleanup();
    AttemptTracker.clear(true);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["mobile +55", "+55 (38) 99999-9999", "38999999999"],
    ["mobile E164", "5538999999999", "38999999999"],
    ["landline +55", "+55 (38) 3222-2222", "3832222222"],
    ["northern mobile +55", "+55 (91) 99999-9999", "91999999999"],
    ["northern landline +55", "+55 (91) 3222-2222", "9132222222"],
    ["DDD 55 mobile +55", "+55 (55) 99999-9999", "55999999999"],
    ["DDD 55 landline +55", "+55 (55) 3222-2222", "5532222222"],
  ])("AUD3-F01: preserves valid %s phone rather than truncating its subscriber digits", async (_label, input, normalized) => {
    expect(Validators.phone(input)).toBe(true);
    renderPortal();
    await flush();
    await submit(input);
    expect.soft((screen.queryByLabelText("Telefone") as HTMLInputElement | null)?.value.replace(/\D/g, "") || normalized).toBe(normalized);
    expect.soft(api.initAttempt).toHaveBeenCalledTimes(1);
    expect(api.identify).toHaveBeenCalledWith(expect.objectContaining({ phone: normalized }));
  });

  it.each(["38999999999", "(38) 99999-9999", "(38) 3222-2222", "55999999999", "(55) 99999-9999", "(55) 3222-2222"])("control: valid national phone %s is sent unchanged", async input => {
    renderPortal();
    await flush();
    await submit(input);
    expect(api.identify).toHaveBeenCalledWith(expect.objectContaining({ phone: input.replace(/\D/g, "") }));
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("AUD3-F02: preserves status Retry-After across remount while retaining the same capability", async () => {
    vi.mocked(api.attemptStatus).mockRejectedValueOnce(new ApiError("http", "Aguarde", 429, { retryAfterMs: 30000 }));
    const first = renderPortal();
    await flush();
    await submit();
    await advance(1000);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Aguarde 30 s" }) as HTMLButtonElement).disabled).toBe(true);
    const storedAttempt = AttemptTracker.get()?.attempt_id;
    first.unmount();
    renderPortal();
    await flush();
    expect.soft(AttemptTracker.get()?.attempt_id).toBe(storedAttempt);
    expect.soft(api.identify).toHaveBeenCalledTimes(1);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Aguarde 30 s" }) as HTMLButtonElement).disabled).toBe(true);
    await advance(29999);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.attemptStatus).toHaveBeenCalledTimes(2);
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it.each(["389999999999", "55389999999999", "(55) 99999-999999", "+91 99999-9999", "+55 91999-9999"])("does not submit excess or incomplete/foreign international input %s as another number", async input => {
    renderPortal();
    await flush();
    await submit(input);
    expect(screen.getByRole("alert").textContent).toContain("telefone válido");
    expect(api.identify).not.toHaveBeenCalled();
    expect(api.initAttempt).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Telefone") as HTMLInputElement).value.replace(/\D/g, "")).toBe(input.replace(/\D/g, ""));
  });

  it("keeps excess subscriber digits while editing a national DDD 55 number", async () => {
    renderPortal();
    await flush();
    const field = screen.getByLabelText("Telefone") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "(55) 99999-9999" } });
    fireEvent.change(field, { target: { value: field.value + "9" } });
    fireEvent.change(field, { target: { value: field.value + "9" } });
    fireEvent.change(screen.getByLabelText("CPF"), { target: { value: "52998224725" } });
    fireEvent.click(screen.getByRole("button", { name: "Liberar Wi-Fi" }));
    await flush();
    expect(field.value.replace(/\D/g, "")).toBe("5599999999999");
    expect(api.initAttempt).not.toHaveBeenCalled();
    expect(api.identify).not.toHaveBeenCalled();
  });

  it("preserves each digit when an international number is typed progressively", async () => {
    renderPortal();
    await flush();
    const field = screen.getByLabelText("Telefone") as HTMLInputElement;
    for (const digit of "+5538999999999") {
      fireEvent.change(field, { target: { value: field.value + digit } });
    }
    fireEvent.change(screen.getByLabelText("CPF"), { target: { value: "52998224725" } });
    fireEvent.click(screen.getByRole("button", { name: "Liberar Wi-Fi" }));
    await flush();
    expect(api.identify).toHaveBeenCalledWith(expect.objectContaining({ phone: "38999999999" }));
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("consults a restored capability immediately when no cooldown exists", async () => {
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.markSubmitted(attempt.attempt_id);
    renderPortal();
    await flush();
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    expect(api.attemptStatus).toHaveBeenCalledWith({ attempt_id: attempt.attempt_id, token: attempt.token });
    expect(api.identify).not.toHaveBeenCalled();
    expect(api.authorizeExisting).not.toHaveBeenCalled();
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("keeps status Retry-After while visiting and returning from the privacy route", async () => {
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.markSubmitted(attempt.attempt_id);
    vi.mocked(api.attemptStatus).mockRejectedValueOnce(new ApiError("http", "Aguarde", 429, { retryAfterMs: 30000 }));
    render(<MemoryRouter><Routes>
      <Route path="/" element={<App />} />
      <Route path="/politica-privacidade" element={<Link to="/">Voltar ao portal</Link>} />
    </Routes></MemoryRouter>);
    await flush();
    fireEvent.click(screen.getByRole("link", { name: "Política de Privacidade" }));
    await advance(5000);
    fireEvent.click(screen.getByRole("link", { name: "Voltar ao portal" }));
    await flush();
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Aguarde 25 s" }) as HTMLButtonElement).disabled).toBe(true);
    await advance(24999);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.attemptStatus).toHaveBeenCalledTimes(2);
    expect(api.identify).not.toHaveBeenCalled();
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("control: status Retry-After is honored when the document stays mounted", async () => {
    vi.mocked(api.attemptStatus).mockRejectedValueOnce(new ApiError("http", "Aguarde", 429, { retryAfterMs: 30000 }));
    renderPortal();
    await flush();
    await submit();
    await advance(1000);
    for (let i = 0; i < 5; i++) fireEvent(window, new Event("pageshow"));
    await advance(29999);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.attemptStatus).toHaveBeenCalledTimes(2);
    expect(api.identify).toHaveBeenCalledTimes(1);
  });
});
