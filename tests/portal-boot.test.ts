// @vitest-environment node
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../src/portal-boot.js", import.meta.url), "utf8");
const html = '<div id="root">Loading</div><section id="portal-recovery" hidden><p id="portal-recovery-message"></p><button id="portal-retry">Retry</button></section>';
const windows: JSDOM[] = [];

function setup(options: { empty?: boolean; unsupported?: boolean; noGlobalThis?: boolean } = {}) {
  const dom = new JSDOM(options.empty ? "" : html, { runScripts: "outside-only", url: "https://portal.test/?id=synthetic#return" });
  windows.push(dom);
  const { window } = dom;
  Object.defineProperty(window.document, "readyState", { value: options.empty ? "loading" : "complete", configurable: true });
  if (!options.unsupported) Object.defineProperty(window.HTMLScriptElement.prototype, "noModule", { value: false, configurable: true });
  if (options.noGlobalThis) delete (window as any).globalThis;
  Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } });
  Object.defineProperty(window, "sessionStorage", { get() { throw new Error("denied"); } });
  vi.useFakeTimers();
  window.setTimeout = setTimeout as any;
  window.clearTimeout = clearTimeout as any;
  window.eval(source);
  return { window, boot: (window as any).__MBPortalBoot, recovery: () => window.document.getElementById("portal-recovery") as HTMLElement };
}

afterEach(() => {
  windows.splice(0).forEach(dom => dom.window.close());
  vi.useRealTimers();
});

describe("independent portal startup recovery", () => {
  it("restores missing globalThis without requiring storage and preserves an existing value", () => {
    const missing = setup({ noGlobalThis: true });
    expect(missing.window.eval("globalThis === window")).toBe(true);
    const existing = setup();
    expect(existing.window.eval("globalThis === window")).toBe(true);
  });

  it("shows a finite timeout and accepts a late successful mount", () => {
    const { window, boot, recovery } = setup();
    vi.advanceTimersByTime(10000);
    expect(recovery().hidden).toBe(false);
    expect(recovery().dataset.failure).toBe("timeout");
    expect(window.document.getElementById("root")!.hidden).toBe(true);
    boot.ready();
    expect(recovery().hidden).toBe(true);
    expect(window.document.getElementById("root")!.hidden).toBe(false);
    expect(window.location.href).toBe("https://portal.test/?id=synthetic#return");
  });

  it("does not time out after the app is ready", () => {
    const { boot, recovery } = setup();
    boot.ready();
    vi.advanceTimersByTime(30000);
    expect(recovery().hidden).toBe(true);
  });

  it("remembers a resource failure before the body exists", () => {
    const { window, recovery } = setup({ empty: true });
    const script = window.document.createElement("script");
    window.document.head.appendChild(script);
    script.dispatchEvent(new window.Event("error"));
    window.document.body.innerHTML = html;
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
    expect(recovery().hidden).toBe(false);
    expect(recovery().dataset.failure).toBe("script");
  });

  it("keeps CSS or render failure visible despite a ready marker", () => {
    const { window, boot, recovery } = setup();
    const link = window.document.createElement("link");
    link.rel = "stylesheet";
    window.document.head.appendChild(link);
    link.dispatchEvent(new window.Event("error"));
    boot.ready();
    expect(recovery().dataset.failure).toBe("stylesheet");
    expect(recovery().hidden).toBe(false);
    boot.fail("render");
    boot.ready();
    expect(recovery().hidden).toBe(false);
  });

  it("releases a pending stylesheet so the recovery page can paint", () => {
    const { window, boot, recovery } = setup();
    const link = window.document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/pending.css";
    window.document.head.appendChild(link);
    vi.advanceTimersByTime(10000);
    expect(link.isConnected).toBe(false);
    expect(recovery().dataset.failure).toBe("stylesheet");
    boot.ready();
    expect(recovery().hidden).toBe(false);
  });

  it("ignores image errors and handled application activity after startup", () => {
    const { window, boot, recovery } = setup();
    const img = window.document.createElement("img");
    window.document.body.appendChild(img);
    img.dispatchEvent(new window.Event("error"));
    expect(recovery().hidden).toBe(true);
    boot.ready();
    window.dispatchEvent(new window.Event("unhandledrejection"));
    expect(recovery().hidden).toBe(true);
  });

  it("explains missing module support without an automatic reload", () => {
    const { window, boot, recovery } = setup({ unsupported: true });
    expect(recovery().dataset.failure).toBe("unsupported");
    expect(window.document.getElementById("portal-retry")!.hidden).toBe(true);
    boot.ready();
    expect(recovery().hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    const link = window.document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/later.css";
    window.document.head.appendChild(link);
    vi.advanceTimersByTime(10000);
    expect(link.isConnected).toBe(false);
    expect(recovery().dataset.failure).toBe("unsupported");
    expect(vi.getTimerCount()).toBe(0);
  });
});
