import type { Command } from "./_generated/types.gen";
import { CommandError } from "./errors";

/** The outcome of `vm.run()`. */
export class CommandResult {
  readonly id: string;
  readonly state: NonNullable<Command["state"]>;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(c: Command) {
    this.id = c.id ?? "";
    this.state = c.state ?? "running";
    this.exit_code = c.exit_code ?? null;
    this.stdout = c.stdout ?? "";
    this.stderr = c.stderr ?? "";
  }

  /** True when the command exited with code 0. */
  get ok(): boolean {
    return this.exit_code === 0;
  }

  /** Return this result, or throw `CommandError` unless the exit code is 0. */
  check(): this {
    if (!this.ok) throw new CommandError(this);
    return this;
  }
}

/** One piece of streamed command output. */
export interface CommandEvent {
  type: "started" | "stdout" | "stderr" | "exit" | (string & {});
  /** Decoded text for `stdout` and `stderr`; the raw JSON payload otherwise. */
  data: string;
  /** The undecoded output bytes of `stdout` and `stderr` events. */
  bytes?: Uint8Array;
  /** Set on `exit` events; `null` when a signal ended the command. */
  exit_code?: number | null;
  /** Set on `exit` events when a signal ended the command. */
  signal?: number;
  /** Set on `exit` events. */
  timed_out?: boolean;
}

function base64Bytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Turns the SSE frames of one command stream into events. Output text is decoded incrementally per stream,
 * so a multi-byte character split across frames stays whole.
 */
export class StreamDecoder {
  private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

  event(type: string, raw: string): CommandEvent[] {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return [{ type, data: raw }];
      body = parsed as Record<string, unknown>;
    } catch {
      return [{ type, data: raw }];
    }
    if (type === "stdout" || type === "stderr") {
      const bytes = base64Bytes(typeof body["data"] === "string" ? body["data"] : "");
      return [{ type, data: this.decoders[type].decode(bytes, { stream: true }), bytes }];
    }
    if (type === "exit") {
      const exit: CommandEvent = {
        type,
        data: raw,
        exit_code: typeof body["exit_code"] === "number" ? body["exit_code"] : null,
        timed_out: body["timed_out"] === true,
      };
      if (typeof body["signal"] === "number") exit.signal = body["signal"];
      return [...this.flush(), exit];
    }
    return [{ type, data: raw }];
  }

  private flush(): CommandEvent[] {
    const out: CommandEvent[] = [];
    for (const type of ["stdout", "stderr"] as const) {
      const tail = this.decoders[type].decode();
      if (tail) out.push({ type, data: tail, bytes: new Uint8Array() });
    }
    return out;
  }
}
