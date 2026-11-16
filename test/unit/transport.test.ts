import { describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  AuthenticationError,
  ConflictError,
  LimitConcurrentError,
  NotFoundError,
  RateLimitError,
  ServerError,
  Styne,
  StyneError,
} from "../../src";
import { json, mockClient, VM } from "./helpers";

const realSetTimeout = globalThis.setTimeout;
/** Run backoff sleeps at once; the per-attempt timeout timer keeps its real delay. */
const noWait = () =>
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === 60_000) return realSetTimeout(fn, ms);
    fn();
    return 0;
  }) as unknown as typeof setTimeout);

describe("requests", () => {
  it("sends auth, user agent and an idempotency key on POST", async () => {
    const { styne, calls } = mockClient([json(201, VM)]);
    await styne.vms.create({ template: "code" });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.test/v1/vms");
    expect(call.headers.get("authorization")).toBe("Bearer sty_test_key");
    expect(call.headers.get("user-agent")).toMatch(/^styne-js\/\d/);
    expect(call.headers.get("idempotency-key")).toBeTruthy();
    expect(JSON.parse(call.body)).toEqual({ template: "code" });
  });

  it("requires an API key and reads STYNE_API_KEY", () => {
    vi.stubEnv("STYNE_API_KEY", "");
    expect(() => new Styne({ apiKey: "" })).toThrow(/missing API key/);
    vi.stubEnv("STYNE_API_KEY", "sty_env_key");
    expect(() => new Styne()).not.toThrow();
    vi.unstubAllEnvs();
  });
});

describe("errors", () => {
  it("maps the v1 envelope to typed errors with the request id", async () => {
    const body = { error: { code: "limit_concurrent", status: 429, message: "too many VMs", origin: "customer_limit", request_id: "req_1" } };
    const { styne } = mockClient([json(429, body, { "Retry-After": "0" })], { maxRetries: 0 });
    const err = await styne.vms.get("vm_abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LimitConcurrentError);
    expect(err).toBeInstanceOf(StyneError);
    expect((err as LimitConcurrentError).requestId).toBe("req_1");
    expect((err as LimitConcurrentError).origin).toBe("customer_limit");
  });

  it("falls back to the status when the body has no error envelope", async () => {
    const flat = { code: 404, error_code: "not_found", message: "no vm", origin: "client", request_id: "r2" };
    const a = mockClient([json(404, flat)]);
    expect(await a.styne.vms.get("x").catch((e: unknown) => e)).toBeInstanceOf(NotFoundError);
    const b = mockClient([json(401, { message: "bad key" })]);
    expect(await b.styne.vms.get("x").catch((e: unknown) => e)).toBeInstanceOf(AuthenticationError);
  });
});

describe("retries", () => {
  it("retries 503 then succeeds, reusing the idempotency key", async () => {
    const spy = noWait();
    const { styne, calls } = mockClient([json(503, { error: { code: "capacity", status: 503, message: "busy", request_id: "r" } }), json(201, VM)]);
    const vm = await styne.vms.create();
    spy.mockRestore();
    expect(vm.id).toBe("vm_abc");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get("idempotency-key")).toBe(calls[0]!.headers.get("idempotency-key"));
  });

  it("honours Retry-After on 429 and gives up after maxRetries", async () => {
    const spy = noWait();
    const reply = () => json(429, { error: { code: "limit_rate_minute", status: 429, message: "slow", request_id: "r" } }, { "Retry-After": "1" });
    const { styne, calls } = mockClient([reply(), reply(), reply()]);
    const err = await styne.vms.get("vm_abc").catch((e: unknown) => e);
    expect(spy.mock.calls.some(([, ms]) => ms === 1000)).toBe(true);
    spy.mockRestore();
    expect(err).toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(3);
  });

  it("retries network failures and surfaces APIConnectionError", async () => {
    const spy = noWait();
    const { styne, calls } = mockClient([new Error("reset"), new Error("reset"), new Error("reset")]);
    const err = await styne.vms.get("vm_abc").catch((e: unknown) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(calls).toHaveLength(3);
  });

  it("does not retry 4xx", async () => {
    const { styne, calls } = mockClient([json(422, { error: { code: "invalid_argument", status: 422, message: "bad", request_id: "r" } })]);
    await styne.vms.get("vm_abc").catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it("surfaces 5xx as ServerError once retries are spent", async () => {
    const spy = noWait();
    const { styne } = mockClient([json(500, { message: "x" }), json(500, { message: "x" }), json(500, { message: "x" })]);
    const err = await styne.vms.get("vm_abc").catch((e: unknown) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(ServerError);
  });

  it("never retries a command: one request on 503 and on a network error", async () => {
    const spy = noWait();
    const busy = () => json(503, { error: { code: "upstream_error", status: 503, message: "busy", request_id: "r" } });
    const a = mockClient([json(201, VM), busy(), busy()]);
    const vm = await a.styne.vms.create();
    expect(await vm.run("make").catch((e: unknown) => e)).toBeInstanceOf(ServerError);
    expect(a.calls).toHaveLength(2);
    expect(a.calls[1]!.headers.get("idempotency-key")).toBeNull();
    const b = mockClient([json(201, VM), new Error("reset"), json(200, {})]);
    const vm2 = await b.styne.vms.create();
    expect(await vm2.run("make").catch((e: unknown) => e)).toBeInstanceOf(APIConnectionError);
    expect(b.calls).toHaveLength(2);
    spy.mockRestore();
  });

  it("retries a create that answers 409 with Retry-After while its key is in flight", async () => {
    const spy = noWait();
    const inFlight = json(409, { error: { code: "conflict", status: 409, message: "in flight", request_id: "r" } }, { "Retry-After": "1" });
    const { styne, calls } = mockClient([inFlight, json(201, VM)]);
    expect((await styne.vms.create()).id).toBe("vm_abc");
    expect(calls).toHaveLength(2);
    const plain = mockClient([json(409, { error: { code: "conflict", status: 409, message: "x", request_id: "r" } })]);
    expect(await plain.styne.vms.get("vm_abc").catch((e: unknown) => e)).toBeInstanceOf(ConflictError);
    spy.mockRestore();
  });

  it("treats 404 on a retried DELETE as done", async () => {
    const spy = noWait();
    const { styne, calls } = mockClient([json(201, VM), json(502, { message: "edge" }), json(404, { error: { code: "not_found", status: 404, message: "gone", request_id: "r" } })]);
    const vm = await styne.vms.create();
    await vm.kill();
    expect(calls).toHaveLength(3);
    spy.mockRestore();
  });

  it("refuses a plain http base URL except for localhost", () => {
    expect(() => new Styne({ apiKey: "k", baseUrl: "http://api.example.com/v1" })).toThrow(StyneError);
    expect(() => new Styne({ apiKey: "k", baseUrl: "http://localhost:8080/v1" })).not.toThrow();
  });
});

