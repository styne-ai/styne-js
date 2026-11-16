import { describe, expect, it } from "vitest";
import { StyneError, isSocketClosed } from "../../src";
import { BROWSER, json, mockClient } from "./helpers";

function launcher() {
  const urls: string[] = [];
  return {
    urls,
    connectOverCDP: (url: string) => {
      urls.push(url);
      return Promise.resolve({ attempt: urls.length - 1 });
    },
  };
}

describe("isSocketClosed", () => {
  it("matches closed sockets only", () => {
    expect(isSocketClosed(new Error("Target page, context or browser has been closed"))).toBe(true);
    expect(isSocketClosed(Object.assign(new Error("read failed"), { code: "ECONNRESET" }))).toBe(true);
    expect(isSocketClosed(new Error("browserType.connectOverCDP: WebSocket error: socket hang up"))).toBe(true);
    expect(isSocketClosed(new Error("selector #go not found"))).toBe(false);
    expect(isSocketClosed(new StyneError("page closed"))).toBe(false);
    expect(isSocketClosed(new Error("payment dialog not open"))).toBe(false);
    expect(isSocketClosed(new Error("homepage closed for maintenance"))).toBe(false);
    expect(isSocketClosed(new Error("Timeout 30000ms exceeded"))).toBe(false);
    expect(isSocketClosed(new Error("navigation failed", { cause: new Error("socket hang up") }))).toBe(true);
  });
});

describe("browser.withReconnect", () => {
  it("connects again after a closed socket and passes the attempt", async () => {
    const { styne, calls } = mockClient([json(200, BROWSER), json(200, BROWSER), json(200, BROWSER), json(200, BROWSER)]);
    const browser = await styne.browsers.get("br_abc");
    const l = launcher();
    const seen: number[] = [];
    const result = await browser.withReconnect(
      l,
      (b, attempt) => {
        seen.push(attempt);
        if (attempt < 2) return Promise.reject(new Error("Target page, context or browser has been closed"));
        return Promise.resolve(b.attempt);
      },
      { delayMs: 1 },
    );
    expect(result).toBe(2);
    expect(seen).toEqual([0, 1, 2]);
    expect(l.urls).toEqual(Array(3).fill(BROWSER.cdp_url));
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "GET"]);
  });

  it("rethrows other errors at once", async () => {
    const { styne } = mockClient([json(200, BROWSER), json(200, BROWSER)]);
    const browser = await styne.browsers.get("br_abc");
    await expect(
      browser.withReconnect(launcher(), () => Promise.reject(new TypeError("bad selector")), { delayMs: 1 }),
    ).rejects.toThrow("bad selector");
  });

  it("gives up after maxReconnects", async () => {
    const { styne } = mockClient(Array.from({ length: 4 }, () => json(200, BROWSER)));
    const browser = await styne.browsers.get("br_abc");
    let runs = 0;
    await expect(
      browser.withReconnect(
        launcher(),
        () => {
          runs++;
          return Promise.reject(Object.assign(new Error("gone"), { code: "ECONNRESET" }));
        },
        { maxReconnects: 2, delayMs: 1 },
      ),
    ).rejects.toThrow("gone");
    expect(runs).toBe(3);
  });

  it("stops when the browser is no longer running", async () => {
    const { styne } = mockClient([json(200, BROWSER), json(200, { ...BROWSER, state: "stopped" })]);
    const browser = await styne.browsers.get("br_abc");
    await expect(
      browser.withReconnect(launcher(), () => Promise.reject(new Error("socket hang up")), { delayMs: 1 }),
    ).rejects.toThrow("stopped, not running");
  });

  it("uses the refreshed url, a custom classifier and maxReconnects 0", async () => {
    const { styne } = mockClient([
      json(200, BROWSER),
      json(200, { ...BROWSER, cdp_url: "wss://cdp.test/new" }),
      json(200, { ...BROWSER, cdp_url: "wss://cdp.test/new" }),
      json(200, BROWSER),
    ]);
    const browser = await styne.browsers.get("br_abc");
    const l = launcher();
    const result = await browser.withReconnect(
      l,
      (b, attempt) => (attempt === 0 ? Promise.reject(new Error("renderer crashed")) : Promise.resolve(b.attempt)),
      { delayMs: 1, isDisconnect: (e) => String(e).includes("crashed") },
    );
    expect(result).toBe(1);
    expect(l.urls).toEqual(["wss://cdp.test/new", "wss://cdp.test/new"]);
    await expect(
      browser.withReconnect(launcher(), () => Promise.reject(new Error("socket hang up")), { maxReconnects: 0 }),
    ).rejects.toThrow("socket hang up");
  });
});
