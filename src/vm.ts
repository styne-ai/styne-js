import {
  createCheckpoint,
  createSnapshot,
  exposePort,
  extendVm,
  forkVm,
  getVm,
  hidePort,
  killVm,
  listCheckpoints,
  listPorts,
  pauseVm,
  resumeVm,
  rewindVm,
  runCommand,
} from "./_generated/sdk.gen";
import type { Checkpoint, Port, Snapshot, Vm as VmData } from "./_generated/types.gen";
import { CommandResult, StreamDecoder, type CommandEvent } from "./command";
import type { Context } from "./context";
import { errorFromResponse, ignoreNotFound } from "./errors";
import { parseSse } from "./sse";
import { IDEMPOTENT, TIMEOUT_HEADER } from "./transport";

export type PauseTier = "hot" | "standby" | "archived";

/** Options of `vm.run()` and `vm.stream()`; field names follow the API. */
export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
  stdin?: string;
  /** Kill the command after this many seconds. Without it the call waits as long as the command runs. */
  timeout_seconds?: number;
  signal?: AbortSignal;
}

/** Options of `vm.run()`. */
export interface RunCommandOptions extends RunOptions {
  /** Return as soon as the command starts; read its output later. */
  detach?: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  type: string;
  size?: number;
}

/** Extra seconds the HTTP call waits beyond a command's own timeout, so the server's answer arrives first. */
const RUN_SLACK_SECONDS = 15;

function runBody(command: string | string[], o: RunCommandOptions, stream: boolean) {
  const [cmd, ...args] = typeof command === "string" ? ["sh", "-c", command] : command;
  if (!cmd) throw new TypeError("command is empty");
  if (o.timeout_seconds !== undefined && !(o.timeout_seconds > 0)) throw new RangeError("timeout_seconds must be positive");
  return {
    cmd,
    ...(args.length > 0 && { args }),
    ...(o.cwd && { cwd: o.cwd }),
    ...(o.env && { env: o.env }),
    ...(o.user && { user: o.user }),
    ...(o.stdin !== undefined && { stdin: o.stdin }),
    ...(o.timeout_seconds !== undefined && { timeout_seconds: Math.ceil(o.timeout_seconds) }),
    ...(o.detach && { detach: true }),
    ...(stream && { stream: true }),
  };
}

/** HTTP wait for a command: its own timeout plus slack, or none at all when the command has no timeout. */
function runTimeoutHeader(o: RunOptions): Record<string, string> {
  const ms = o.timeout_seconds === undefined ? 0 : (Math.ceil(o.timeout_seconds) + RUN_SLACK_SECONDS) * 1000;
  return { [TIMEOUT_HEADER]: String(ms) };
}

/** Files inside a VM. */
export class VmFiles {
  constructor(
    private readonly ctx: Context,
    private readonly vmId: string,
  ) {}

  private url(suffix: string, path: string): string {
    const q = new URLSearchParams({ path });
    return `${this.ctx.baseUrl}/vms/${encodeURIComponent(this.vmId)}/files${suffix}?${q}`;
  }

  /** Return the content of a file. */
  async read(path: string): Promise<Uint8Array> {
    const res = await this.ctx.fetch(this.url("", path));
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Return the content of a UTF-8 text file. */
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }

  /** Create or replace a file; a string is written as UTF-8. */
  async write(path: string, content: string | Uint8Array): Promise<void> {
    const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const res = await this.ctx.fetch(this.url("", path), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: body as BodyInit,
    });
    await res.body?.cancel();
  }

  /** List the entries of a directory. */
  async list(path = "/"): Promise<FileEntry[]> {
    const res = await this.ctx.fetch(this.url("/list", path));
    const body = (await res.json()) as { data?: FileEntry[] };
    return body.data ?? [];
  }

  /** Delete a file. */
  async delete(path: string): Promise<void> {
    const res = await this.ctx.fetch(this.url("", path), { method: "DELETE" });
    await res.body?.cancel();
  }
}

/** Ports a VM serves to the internet. */
export class VmPorts {
  constructor(
    private readonly ctx: Context,
    private readonly vmId: string,
  ) {}

  /** Serve a port of the VM at a public URL; `public: true` drops the traffic token. */
  async expose(port: number, options: { public?: boolean } = {}): Promise<Port> {
    const body = { port, ...(options.public !== undefined && { public: options.public }) };
    const { data } = await exposePort({ client: this.ctx.client, throwOnError: true, path: { vm: this.vmId }, body });
    return data;
  }

  /** Return the exposed ports. */
  async list(): Promise<Port[]> {
    const { data } = await listPorts({ client: this.ctx.client, throwOnError: true, path: { vm: this.vmId } });
    return (data as { data?: Port[] }).data ?? [];
  }

  /** Stop serving a port. */
  async hide(port: number): Promise<void> {
    await hidePort({ client: this.ctx.client, throwOnError: true, path: { vm: this.vmId, port } });
  }
}

/** Checkpoints of a VM; `vm.rewind()` returns to one. */
export class VmCheckpoints {
  constructor(
    private readonly ctx: Context,
    private readonly vmId: string,
  ) {}

  /** Record the VM's current state as a checkpoint. */
  async create(label?: string): Promise<Checkpoint> {
    const { data } = await createCheckpoint({
      client: this.ctx.client,
      throwOnError: true,
      path: { vm: this.vmId },
      body: label === undefined ? {} : { label },
      headers: IDEMPOTENT,
    });
    return data;
  }

  /** Return the VM's checkpoints. */
  async list(): Promise<Checkpoint[]> {
    const { data } = await listCheckpoints({ client: this.ctx.client, throwOnError: true, path: { vm: this.vmId } });
    return (data as { data?: Checkpoint[] }).data ?? [];
  }
}

/** A running, paused or ended VM. Fields mirror the API object and update on `refresh()`. */
export class Vm {
  readonly files: VmFiles;
  readonly ports: VmPorts;
  readonly checkpoints: VmCheckpoints;

  constructor(
    private readonly ctx: Context,
    private data: VmData,
  ) {
    this.files = new VmFiles(ctx, data.id);
    this.ports = new VmPorts(ctx, data.id);
    this.checkpoints = new VmCheckpoints(ctx, data.id);
  }

  get id(): string {
    return this.data.id;
  }
  get state(): VmData["state"] {
    return this.data.state;
  }
  /** The full record as last seen. */
  get info(): Readonly<VmData> {
    return this.data;
  }

  private get path() {
    return { vm: this.id };
  }

  /** Reload the record from the API. */
  async refresh(): Promise<this> {
    const { data } = await getVm({ client: this.ctx.client, throwOnError: true, path: this.path });
    this.data = data;
    return this;
  }

  /**
   * Run a command and wait for it to finish. A string runs through `sh -c`; an array is executed directly.
   * A command is sent once and never retried.
   */
  async run(cmd: string | string[], options: RunCommandOptions = {}): Promise<CommandResult> {
    const { data } = await runCommand({
      client: this.ctx.client,
      throwOnError: true,
      path: this.path,
      body: runBody(cmd, options, false),
      headers: runTimeoutHeader(options),
      ...(options.signal && { signal: options.signal }),
    });
    return new CommandResult(data);
  }

  /** Run a command and yield its output as it is produced; throws the matching error on a server error event. */
  async *stream(cmd: string | string[], options: RunOptions = {}): AsyncGenerator<CommandEvent> {
    const res = await this.ctx.fetch(`${this.ctx.baseUrl}/vms/${encodeURIComponent(this.id)}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(runBody(cmd, options, true)),
      ...(options.signal && { signal: options.signal }),
    });
    const decoder = new StreamDecoder();
    for await (const ev of parseSse(res, options.signal)) {
      if (ev.event === "error") {
        const body: unknown = JSON.parse(ev.data);
        const inner = (body as { error?: { status?: unknown } } | null)?.error;
        throw errorFromResponse(typeof inner?.status === "number" ? inner.status : 500, body, new Headers());
      }
      yield* decoder.event(ev.event, ev.data);
    }
  }

  /** Pause the VM; `tier` defaults to the server's choice. */
  async pause(tier?: PauseTier): Promise<this> {
    const body = tier === undefined ? {} : { tier };
    const { data } = await pauseVm({ client: this.ctx.client, throwOnError: true, path: this.path, body });
    this.data = data;
    return this;
  }

  /** Resume a paused VM. */
  async resume(): Promise<this> {
    const { data } = await resumeVm({ client: this.ctx.client, throwOnError: true, path: this.path });
    this.data = data;
    return this;
  }

  /** Extend the VM's lifetime by `seconds`. */
  async extend(seconds: number): Promise<this> {
    const { data } = await extendVm({ client: this.ctx.client, throwOnError: true, path: this.path, body: { seconds } });
    this.data = data;
    return this;
  }

  /** Create `count` copies of this VM from its current state. */
  async fork(options: { count?: number } = {}): Promise<Vm[]> {
    const { data } = await forkVm({
      client: this.ctx.client,
      throwOnError: true,
      path: this.path,
      body: { count: options.count ?? 1 },
      headers: IDEMPOTENT,
    });
    return data.data?.map((v) => new Vm(this.ctx, v)) ?? [];
  }

  /** Save the VM's state as a snapshot that new VMs can start from. */
  async snapshot(name?: string): Promise<Snapshot> {
    const { data } = await createSnapshot({
      client: this.ctx.client,
      throwOnError: true,
      path: this.path,
      body: name === undefined ? {} : { name },
      headers: IDEMPOTENT,
    });
    return data;
  }

  /** Return the VM to a checkpoint (id or object). */
  async rewind(checkpoint: string | Checkpoint): Promise<this> {
    const id = typeof checkpoint === "string" ? checkpoint : (checkpoint.id ?? "");
    const { data } = await rewindVm({
      client: this.ctx.client,
      throwOnError: true,
      path: this.path,
      body: { checkpoint: id },
    });
    this.data = data;
    return this;
  }

  /** Delete the VM. */
  async kill(): Promise<void> {
    await killVm({ client: this.ctx.client, throwOnError: true, path: this.path });
  }

  /** `await using vm = ...` deletes the VM at the end of the scope; a VM that is already gone is fine. */
  async [Symbol.asyncDispose](): Promise<void> {
    await ignoreNotFound(this.kill());
  }
}
