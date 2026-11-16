import { StyneError } from "./errors";

const SOCKET_CLOSED =
  /\btarget (page, context or browser|closed)\b|\b(browser|connection|websocket|socket) (has been |was )?closed\b|\bconnection (reset|refused|lost)\b|\bwebsocket (error|is not open)\b|\bsocket hang up\b|\bno close frame\b|\b(ECONNRESET|EPIPE)\b/i;

/** True when `error` or its `cause` says the CDP socket is gone: a Node socket error or a Playwright or Puppeteer close message. Timeouts and Styne API errors are not. */
export function isSocketClosed(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (current instanceof StyneError) return false;
    const text =
      current instanceof Error ? `${current.name} ${current.message} ${(current as { code?: string }).code ?? ""}` : typeof current === "string" ? current : "";
    if (SOCKET_CLOSED.test(text)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** Options of `browser.withReconnect`. */
export interface ReconnectOptions {
  /** How many times to connect again after a closed socket (default 5). */
  maxReconnects?: number;
  /** Base wait in milliseconds; the wait before reconnect n is `delayMs * n` (default 500). */
  delayMs?: number;
  /** Decides which errors mean a closed socket (default `isSocketClosed`). */
  isDisconnect?: (error: unknown) => boolean;
}

export function notRunning(id: string, state: string): StyneError {
  return new StyneError(`browser ${id} is ${state || "unknown"}, not running`);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
