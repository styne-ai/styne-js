import { Styne, type StyneOptions } from "../../src";

export interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** A Styne client whose fetch replays the given responses in order and records every request. */
export function mockClient(replies: (Response | Error)[], options: StyneOptions = {}) {
  const calls: Recorded[] = [];
  const queue = [...replies];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: await req.text() });
    const next = queue.shift();
    if (!next) throw new Error("no more mock replies");
    if (next instanceof Error) throw next;
    return next;
  };
  const styne = new Styne({ apiKey: "sty_test_key", baseUrl: "https://api.test/v1", maxRetries: 2, ...options, fetch: fetchImpl });
  return { styne, calls };
}

export const VM = { id: "vm_abc", state: "running", created_at: "2026-11-16T10:00:00Z" };
export const BROWSER = { id: "br_abc", state: "running", cdp_url: "wss://cdp.test/br_abc?token=t", live_view_url: "https://live.test/br_abc" };
