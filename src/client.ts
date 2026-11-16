import {
  connectVm,
  createBrowser,
  createVm,
  deleteSnapshot,
  getBrowser,
  getSnapshot,
  getUsage,
  getVm,
  listBrowsers,
  listRegions,
  listSnapshots,
  listTemplates,
  listVms,
  startFromSnapshot,
} from "./_generated/sdk.gen";
import type { CreateBrowser, CreateVm, Region, Snapshot, Template } from "./_generated/types.gen";
import { Browser } from "./browser";
import type { Context } from "./context";
import { StyneError } from "./errors";
import { paginate } from "./pages";
import { IDEMPOTENT, chosenRegion, createTransport, resolveBaseUrl, type TransportOptions } from "./transport";
import { Vm } from "./vm";

export interface StyneOptions extends Partial<Omit<TransportOptions, "apiKey">> {
  /** Defaults to the STYNE_API_KEY environment variable. */
  apiKey?: string;
}

/** Options of the `list()` iterators. */
export interface ListOptions {
  /** Items fetched per request; iteration still walks every page. */
  page_size?: number;
}

function pageQuery(options: ListOptions, cursor: string | undefined) {
  return { ...(cursor && { cursor }), ...(options.page_size !== undefined && { limit: options.page_size }) };
}

/** A create names the client region unless the call names one itself. */
function withRegion<T extends { region?: string | null }>(params: T, ctx: Context): T {
  return ctx.region && !params.region ? { ...params, region: ctx.region } : params;
}

function withVmRegion(params: CreateVm, ctx: Context): CreateVm {
  return params.snapshot ? params : withRegion(params, ctx);
}

/** Create, find and list VMs. */
class Vms {
  constructor(private readonly ctx: Context) {}

  /** Start a VM from a template or a snapshot. */
  async create(params: CreateVm = {}): Promise<Vm> {
    const { data } = await createVm({ client: this.ctx.client, throwOnError: true, body: withVmRegion(params, this.ctx), headers: IDEMPOTENT });
    return new Vm(this.ctx, data);
  }

  /** Return a VM by id. */
  async get(id: string): Promise<Vm> {
    const { data } = await getVm({ client: this.ctx.client, throwOnError: true, path: { vm: id } });
    return new Vm(this.ctx, data);
  }

  /** Attach to an existing VM, resuming it if it is paused. */
  async connect(id: string): Promise<Vm> {
    const { data } = await connectVm({ client: this.ctx.client, throwOnError: true, path: { vm: id } });
    return new Vm(this.ctx, data);
  }

  /** Iterate every VM of the account. */
  async *list(options: ListOptions = {}): AsyncGenerator<Vm> {
    const pages = paginate(async (cursor) => {
      const query = pageQuery(options, cursor);
      return (await listVms({ client: this.ctx.client, throwOnError: true, query })).data;
    });
    for await (const v of pages) yield new Vm(this.ctx, v);
  }
}

/** Create, find and list cloud browsers. */
class Browsers {
  constructor(private readonly ctx: Context) {}

  /** Start a browser. */
  async create(params: CreateBrowser = {}): Promise<Browser> {
    const { data } = await createBrowser({
      client: this.ctx.client,
      throwOnError: true,
      body: withRegion(params, this.ctx),
      headers: IDEMPOTENT,
    });
    return new Browser(this.ctx, data);
  }

  /** Return a browser by id. */
  async get(id: string): Promise<Browser> {
    const { data } = await getBrowser({ client: this.ctx.client, throwOnError: true, path: { br: id } });
    return new Browser(this.ctx, data);
  }

  /** Iterate every browser of the account. */
  async *list(options: ListOptions = {}): AsyncGenerator<Browser> {
    const pages = paginate(async (cursor) => {
      const query = pageQuery(options, cursor);
      return (await listBrowsers({ client: this.ctx.client, throwOnError: true, query })).data;
    });
    for await (const b of pages) yield new Browser(this.ctx, b);
  }
}

/** Saved VM states. */
class Snapshots {
  constructor(private readonly ctx: Context) {}

  /** Return a snapshot by id or name. */
  async get(id: string): Promise<Snapshot> {
    const { data } = await getSnapshot({ client: this.ctx.client, throwOnError: true, path: { snap: id } });
    return data;
  }

  /** Iterate every snapshot of the account. */
  async *list(options: ListOptions = {}): AsyncGenerator<Snapshot> {
    yield* paginate(async (cursor) => {
      const query = pageQuery(options, cursor);
      return (await listSnapshots({ client: this.ctx.client, throwOnError: true, query })).data;
    });
  }

  /** Create a VM from a snapshot. */
  async start(id: string): Promise<Vm> {
    const { data } = await startFromSnapshot({
      client: this.ctx.client,
      throwOnError: true,
      path: { snap: id },
      headers: IDEMPOTENT,
    });
    return new Vm(this.ctx, data);
  }

  /** Delete a snapshot. */
  async delete(id: string): Promise<void> {
    await deleteSnapshot({ client: this.ctx.client, throwOnError: true, path: { snap: id } });
  }
}

/** Regions a VM or browser can run in. */
class Regions {
  constructor(private readonly ctx: Context) {}

  /** Return every region. */
  async list(): Promise<Region[]> {
    const { data } = await listRegions({ client: this.ctx.client, throwOnError: true });
    return (data as { data?: Region[] }).data ?? [];
  }
}

/** Templates a VM can start from. */
class Templates {
  constructor(private readonly ctx: Context) {}

  /** Return every template the key can start. */
  async list(): Promise<Template[]> {
    const out: Template[] = [];
    const pages = paginate(async (cursor) => {
      const query = pageQuery({}, cursor);
      return (await listTemplates({ client: this.ctx.client, throwOnError: true, query })).data;
    });
    for await (const t of pages) out.push(t);
    return out;
  }
}

/** Entry point. Reads the key from STYNE_API_KEY and the URL from STYNE_BASE_URL when not given. */
export class Styne {
  readonly vms: Vms;
  readonly browsers: Browsers;
  readonly snapshots: Snapshots;
  readonly regions: Regions;
  readonly templates: Templates;
  private readonly ctx: Context;

  constructor(options: StyneOptions = {}) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const apiKey = options.apiKey ?? env["STYNE_API_KEY"];
    if (!apiKey) throw new StyneError("missing API key: pass `apiKey` or set STYNE_API_KEY");
    this.ctx = { ...createTransport({ ...options, apiKey, baseUrl: resolveBaseUrl(options, env) }), region: chosenRegion(options, env) };
    this.vms = new Vms(this.ctx);
    this.browsers = new Browsers(this.ctx);
    this.snapshots = new Snapshots(this.ctx);
    this.regions = new Regions(this.ctx);
    this.templates = new Templates(this.ctx);
  }

  /** Return usage over a window, grouped by product, key and project. */
  async usage(): Promise<Record<string, unknown>> {
    const { data } = await getUsage({ client: this.ctx.client, throwOnError: true });
    return data;
  }
}
