import { createClient, createConfig, type Client } from "./_generated/client";
import { APIConnectionError, APITimeoutError, StyneError, errorFromResponse, parseRetryAfter } from "./errors";
import { VERSION } from "./version";

export const DEFAULT_BASE_URL = "https://api.styne.ai/v1";
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface TransportOptions {
  apiKey: string;
  baseUrl?: string;
  /** Retries after the first attempt on network errors, 408, 429 and 5xx. Default 2. */
  maxRetries?: number;
  /** Milliseconds to wait for the response headers of one attempt. Default 60000. */
  timeoutMs?: number;
  /** Replace the global fetch (tests, proxies). */
  fetch?: typeof fetch;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
}

/** Internal per-call timeout override in milliseconds ("0" = none); removed before the request is sent. */
export const TIMEOUT_HEADER = "x-sdk-timeout-ms";
/** Internal marker for a POST the server deduplicates by Idempotency-Key; removed before the request is sent. */
export const IDEMPOTENT_HEADER = "x-sdk-idempotent";
/** Header set that marks a call idempotent. */
export const IDEMPOTENT = { [IDEMPOTENT_HEADER]: "1" } as const;

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function userAgent(): string {
  const g = globalThis as { Bun?: unknown; Deno?: unknown; process?: { versions?: { node?: string } } };
  const runtime = g.Bun ? "bun" : g.Deno ? "deno" : `node${g.process?.versions?.node ?? ""}`;
  return `styne-js/${VERSION} (${runtime})`;
}

/** The base URL without a trailing slash; plain http only for localhost. */
export function checkBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname))) {
    throw new StyneError(`base URL must use https (http only for localhost): ${trimmed}`);
  }
  return trimmed;
}

function backoffMs(attempt: number, retryAfterSeconds: number | undefined): number {
  if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1000, 60_000);
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

interface Attempt {
  res?: Response;
  error?: unknown;
  timedOut: boolean;
}

/**
 * One fetch whose timeout covers only the wait for the response headers; reading the body is bounded by the
 * caller's signal alone, so long downloads and streams are not cut.
 */
async function attempt(base: typeof fetch, request: Request, init: RequestInit, timeoutMs: number): Promise<Attempt> {
  const controller = new AbortController();
  const caller = request.signal;
  const forward = () => {
    controller.abort(caller.reason);
  };
  if (caller.aborted) forward();
  else caller.addEventListener("abort", forward, { once: true });
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new APITimeoutError());
        }, timeoutMs)
      : undefined;
  try {
    return { res: await base(request.url, { ...init, signal: controller.signal }), timedOut };
  } catch (error) {
    caller.removeEventListener("abort", forward);
    return { error, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A fetch wrapper that adds auth and timeouts, retries what is safe to retry, and throws typed errors on non-2xx.
 * A POST is retried only when it carries the idempotent marker, which the SDK sets on the calls the server
 * deduplicates by Idempotency-Key (creates, forks, snapshots, checkpoints). Every other POST is sent once.
 */
export function createFetch(options: TransportOptions): typeof fetch {
  const base = options.fetch ?? globalThis.fetch;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ua = userAgent();

  return async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);
    headers.set("Authorization", `Bearer ${options.apiKey}`);
    if (!headers.has("User-Agent")) headers.set("User-Agent", ua);
    const override = headers.get(TIMEOUT_HEADER);
    const timeoutMs = override === null ? defaultTimeoutMs : Number(override) || 0;
    const idempotent = headers.get(IDEMPOTENT_HEADER) === "1";
    headers.delete(TIMEOUT_HEADER);
    headers.delete(IDEMPOTENT_HEADER);
    if (idempotent && !headers.has("Idempotency-Key")) headers.set("Idempotency-Key", globalThis.crypto.randomUUID());
    const retrySafe = idempotent || SAFE_METHODS.has(request.method);
    const body = request.body ? await request.arrayBuffer() : null;
    const fetchInit: RequestInit = { method: request.method, headers, body };

    for (let n = 0; ; n++) {
      const { res, error, timedOut } = await attempt(base, request, fetchInit, timeoutMs);
      if (!res) {
        if (request.signal.aborted) throw error;
        const failure = timedOut ? new APITimeoutError() : new APIConnectionError(String(error), { cause: error });
        if (!retrySafe || n >= maxRetries) throw failure;
        await sleep(backoffMs(n, undefined), request.signal);
        continue;
      }
      if (res.ok) return res;
      if (request.method === "DELETE" && n > 0 && res.status === 404) {
        // The earlier attempt already deleted the object.
        await res.body?.cancel();
        return new Response(null, { status: 204 });
      }
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const retryable =
        retrySafe && RETRY_STATUS.has(res.status) && (res.status !== 409 || (idempotent && retryAfter !== undefined));
      if (retryable && n < maxRetries) {
        await res.body?.cancel();
        await sleep(backoffMs(n, retryAfter), request.signal);
        continue;
      }
      throw errorFromResponse(res.status, await readBody(res), res.headers);
    }
  };
}

export function createTransport(options: TransportOptions): { client: Client; fetch: typeof fetch; baseUrl: string } {
  const fetchImpl = createFetch(options);
  const baseUrl = checkBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const client = createClient(createConfig({ baseUrl, fetch: fetchImpl, throwOnError: true }));
  return { client, fetch: fetchImpl, baseUrl };
}
