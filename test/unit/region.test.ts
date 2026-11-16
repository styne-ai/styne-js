import { describe, expect, it } from "vitest";
import { Styne, StyneError } from "../../src";
import { regionBaseUrl, resolveBaseUrl } from "../../src/transport";

describe("region", () => {
  it("defaults to ash", () => {
    expect(resolveBaseUrl({}, {})).toBe("https://ash.api.styne.ai/v1");
  });

  it("follows the order baseUrl, STYNE_BASE_URL, region, STYNE_REGION, default", () => {
    expect(resolveBaseUrl({}, { STYNE_REGION: "ams" })).toBe("https://ams.api.styne.ai/v1");
    expect(resolveBaseUrl({ region: "ash" }, { STYNE_REGION: "ams" })).toBe("https://ash.api.styne.ai/v1");
    expect(resolveBaseUrl({ region: "ams" }, { STYNE_BASE_URL: "https://api.styne.ai/v1" })).toBe("https://api.styne.ai/v1");
    expect(resolveBaseUrl({ baseUrl: "https://x.example.com", region: "ams" }, { STYNE_BASE_URL: "https://y.example.com" })).toBe(
      "https://x.example.com",
    );
  });

  it("accepts the aliases us-east and eu", () => {
    expect(regionBaseUrl("us-east")).toBe("https://ash.api.styne.ai/v1");
    expect(regionBaseUrl("EU")).toBe("https://ams.api.styne.ai/v1");
  });

  it("rejects an unknown region and lists the choices", () => {
    expect(() => regionBaseUrl("mars")).toThrow(StyneError);
    expect(() => regionBaseUrl("mars")).toThrow(/ash, ams/);
  });

  it("applies to the client requests", async () => {
    const urls: string[] = [];
    const fetchStub = ((input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    }) as typeof fetch;
    await new Styne({ apiKey: "k", region: "ams", fetch: fetchStub }).regions.list();
    await new Styne({ apiKey: "k", fetch: fetchStub }).regions.list();
    expect(urls[0]).toMatch(/^https:\/\/ams\.api\.styne\.ai\/v1\//);
    expect(urls[1]).toMatch(/^https:\/\/ash\.api\.styne\.ai\/v1\//);
  });

  it("is the default region of a create", async () => {
    const bodies: Array<{ region?: string }> = [];
    const fetchStub = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const raw = new TextDecoder().decode(init?.body as ArrayBuffer);
      bodies.push(JSON.parse(raw) as { region?: string });
      return Promise.resolve(new Response(JSON.stringify({ id: "br_1", object: "browser", state: "running", cdp_url: "wss://x" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }));
    }) as typeof fetch;
    await new Styne({ apiKey: "k", region: "eu", fetch: fetchStub }).browsers.create({});
    await new Styne({ apiKey: "k", region: "eu", fetch: fetchStub }).browsers.create({ region: "ash" });
    await new Styne({ apiKey: "k", fetch: fetchStub }).browsers.create({});
    expect(bodies[0]).toMatchObject({ region: "ams" });
    expect(bodies[1]).toMatchObject({ region: "ash" });
    expect(bodies[2]?.region).toBeUndefined();
  });

  it("accepts every alias the API accepts", () => {
    expect(regionBaseUrl("eu-central")).toBe("https://ams.api.styne.ai/v1");
    expect(regionBaseUrl("ASHBURN")).toBe("https://ash.api.styne.ai/v1");
  });

  it("does not add the client region to a create from a snapshot", async () => {
    const bodies: Array<{ region?: string }> = [];
    const fetchStub = ((_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as { region?: string });
      return Promise.resolve(
        new Response(JSON.stringify({ id: "vm_1", object: "vm", state: "running" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    const styne = new Styne({ apiKey: "k", region: "ams", fetch: fetchStub });
    await styne.vms.create({ snapshot: "snap_1" });
    await styne.vms.create({ template: "small" });
    await styne.vms.create({ snapshot: "snap_1", region: "ash" });
    expect(bodies.map((b) => b.region)).toEqual([undefined, "ams", "ash"]);
  });

  it("does not echo credentials of a rejected base URL", () => {
    let message = "";
    try {
      new Styne({ apiKey: "k", baseUrl: "http://user:secret@example.com/v1?token=abc" });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("example.com");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("token");
  });
});
