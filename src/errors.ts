import type { CommandResult } from "./command";

/** Base class for every error the SDK throws. */
export class StyneError extends Error {
  override readonly name: string = "StyneError";
}

/** The request never produced an HTTP response (DNS, TLS, connection reset). */
export class APIConnectionError extends StyneError {
  override readonly name: string = "APIConnectionError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** The request exceeded the client timeout. */
export class APITimeoutError extends APIConnectionError {
  override readonly name: string = "APITimeoutError";
  constructor(message = "request timed out") {
    super(message);
  }
}

/** A command exited with a non-zero code; thrown by `CommandResult.check()`. */
export class CommandError extends StyneError {
  override readonly name: string = "CommandError";
  readonly result: CommandResult;
  constructor(result: CommandResult) {
    super(`command exited with ${String(result.exit_code)}: ${result.stderr.trim().slice(0, 200)}`);
    this.result = result;
  }
}

export interface APIErrorInit {
  status: number;
  code: string;
  message: string;
  requestId?: string;
  /** One of client, customer_limit, infrastructure, guest, agent, unknown (open set). */
  origin?: string;
  details?: Record<string, unknown>;
  docUrl?: string;
  retryAfterSeconds?: number;
}

/** The API answered with an error status. */
export class APIError extends StyneError {
  override readonly name: string = "APIError";
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly origin: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly docUrl: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(init: APIErrorInit) {
    super(init.requestId ? `${init.message} (request ${init.requestId})` : init.message);
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.origin = init.origin;
    this.details = init.details;
    this.docUrl = init.docUrl;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** The request is malformed or a field is invalid (400, 422). */
export class InvalidArgumentError extends APIError {
  override readonly name: string = "InvalidArgumentError";
}
/** An Idempotency-Key was reused with a different body (422). */
export class IdempotencyMismatchError extends InvalidArgumentError {
  override readonly name: string = "IdempotencyMismatchError";
}
/** The API key is invalid or revoked (401). */
export class AuthenticationError extends APIError {
  override readonly name: string = "AuthenticationError";
}
/** The account needs credit or a payment method (402). */
export class PaymentRequiredError extends APIError {
  override readonly name: string = "PaymentRequiredError";
}
/** The action needs a higher plan (402). */
export class PlanRequiredError extends PaymentRequiredError {
  override readonly name: string = "PlanRequiredError";
}
/** The key lacks the scope for this action, or the account is suspended (403). */
export class PermissionDeniedError extends APIError {
  override readonly name: string = "PermissionDeniedError";
}
/** The object does not exist (404). */
export class NotFoundError extends APIError {
  override readonly name: string = "NotFoundError";
}
/** The VM has ended and can no longer run commands. */
export class VmEndedError extends APIError {
  override readonly name: string = "VmEndedError";
}
/** The request conflicts with the current state (409). */
export class ConflictError extends APIError {
  override readonly name: string = "ConflictError";
}
/** A usage quota of the plan (hours, storage) is used up. */
export class QuotaExceededError extends APIError {
  override readonly name: string = "QuotaExceededError";
}
/** A rate limit was hit (429); see `retryAfterSeconds`. */
export class RateLimitError extends APIError {
  override readonly name: string = "RateLimitError";
}
/** The plan's limit on resources running at the same time is reached. */
export class LimitConcurrentError extends RateLimitError {
  override readonly name: string = "LimitConcurrentError";
}
/** No capacity is free in the region right now; retry later or pick another region. */
export class CapacityError extends APIError {
  override readonly name: string = "CapacityError";
}
/** A command ran past its timeout. */
export class CommandTimeoutError extends APIError {
  override readonly name: string = "CommandTimeoutError";
}
/** The service failed (5xx). */
export class ServerError extends APIError {
  override readonly name: string = "ServerError";
}

type APIErrorClass = new (init: APIErrorInit) => APIError;

const BY_CODE: Record<string, APIErrorClass> = {
  unauthenticated: AuthenticationError,
  permission_denied: PermissionDeniedError,
  account_suspended: PermissionDeniedError,
  plan_required: PlanRequiredError,
  payment_required: PaymentRequiredError,
  not_found: NotFoundError,
  vm_ended: VmEndedError,
  conflict: ConflictError,
  failed_precondition: ConflictError,
  invalid_argument: InvalidArgumentError,
  idempotency_mismatch: IdempotencyMismatchError,
  quota_exceeded: QuotaExceededError,
  limit_hours: QuotaExceededError,
  limit_storage: QuotaExceededError,
  limit_concurrent: LimitConcurrentError,
  limit_rate_minute: RateLimitError,
  limit_rate_hour: RateLimitError,
  limit_rate_day: RateLimitError,
  account_throttled: RateLimitError,
  capacity: CapacityError,
  capacity_provisioning: CapacityError,
  command_timeout: CommandTimeoutError,
};

const BY_STATUS: Record<number, APIErrorClass> = {
  400: InvalidArgumentError,
  401: AuthenticationError,
  402: PaymentRequiredError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  422: InvalidArgumentError,
  429: RateLimitError,
};

/** Build the typed error for a non-2xx response body. */
export function errorFromResponse(status: number, body: unknown, headers: Headers): APIError {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const env = (raw["error"] && typeof raw["error"] === "object" ? raw["error"] : {}) as Record<string, unknown>;
  const code = typeof env["code"] === "string" ? env["code"] : "unknown";
  const message =
    typeof env["message"] === "string"
      ? env["message"]
      : typeof raw["message"] === "string"
        ? raw["message"]
        : `HTTP ${String(status)}`;
  const requestId =
    typeof env["request_id"] === "string" ? env["request_id"] : (headers.get("x-request-id") ?? undefined);
  const retryAfterSeconds = parseRetryAfter(headers.get("retry-after"));
  const init: APIErrorInit = { status, code, message };
  if (requestId) init.requestId = requestId;
  if (typeof env["origin"] === "string") init.origin = env["origin"];
  if (env["details"] && typeof env["details"] === "object") init.details = env["details"] as Record<string, unknown>;
  const docUrl = env["doc_url"] ?? raw["doc_url"];
  if (typeof docUrl === "string") init.docUrl = docUrl;
  if (retryAfterSeconds !== undefined) init.retryAfterSeconds = retryAfterSeconds;
  const Cls = BY_CODE[code] ?? BY_STATUS[status] ?? (status >= 500 ? ServerError : APIError);
  return new Cls(init);
}

/** Seconds from a Retry-After header (delta seconds or an HTTP date). */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
}

/** Await a delete, treating "already gone" as done. */
export async function ignoreNotFound(call: Promise<void>): Promise<void> {
  try {
    await call;
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
}
