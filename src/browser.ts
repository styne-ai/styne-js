import {
  getBrowser,
  getBrowserControl,
  giveBackBrowserControl,
  stopBrowser,
  takeBrowserControl,
} from "./_generated/sdk.gen";
import type { Browser as BrowserData } from "./_generated/types.gen";
import type { Context } from "./context";
import { ignoreNotFound } from "./errors";
import { isSocketClosed, notRunning, sleep, type ReconnectOptions } from "./reconnect";

/** The slice of Playwright / Playwright-core's browser type used to attach over CDP. */
export interface CdpLauncher<T> {
  connectOverCDP(endpointUrl: string): Promise<T>;
}

/** A person's hold on a browser, returned by `takeControl()`; field names follow the API. */
export interface Control {
  cdp_url: string;
  control_id: string;
  holder?: string;
}

/** A cloud browser. Point Playwright or Puppeteer at `cdpUrl`. */
export class Browser {
  constructor(
    private readonly ctx: Context,
    private data: BrowserData,
  ) {}

  get id(): string {
    return this.data.id;
  }
  get state(): string {
    return this.data.state;
  }
  /** `wss://` endpoint for `chromium.connectOverCDP` or `puppeteer.connect({ browserWSEndpoint })`. */
  get cdpUrl(): string {
    return this.data.cdp_url;
  }
  get liveViewUrl(): string | undefined {
    return this.data.live_view_url;
  }
  /** The full record as last seen. */
  get info(): Readonly<BrowserData> {
    return this.data;
  }

  private get path() {
    return { br: this.id };
  }

  /** Reload the record from the API. */
  async refresh(): Promise<this> {
    const { data } = await getBrowser({ client: this.ctx.client, throwOnError: true, path: this.path });
    this.data = data;
    return this;
  }

  /** Attach with a Playwright browser type, e.g. `await b.connect(chromium)`. */
  connect<T>(launcher: CdpLauncher<T>): Promise<T> {
    return launcher.connectOverCDP(this.cdpUrl);
  }

  /**
   * Call `run(browser, attempt)` and, when the CDP socket closes, fetch the session again, connect again and call it again
   * (`attempt` counts from 0). The browser, its pages and their state live on the server and survive a closed socket, so
   * make `run` continue from `context.pages()`. `run` starts again from the top, so it must be safe to repeat, and it owns the
   * browser object it is given (close it if you need to). Other errors, and the last one after `maxReconnects` tries, are rethrown.
   */
  async withReconnect<B, T>(
    launcher: CdpLauncher<B>,
    run: (browser: B, attempt: number) => Promise<T>,
    options: ReconnectOptions = {},
  ): Promise<T> {
    const { maxReconnects = 5, delayMs = 500, isDisconnect = isSocketClosed } = options;
    for (let attempt = 0; ; attempt++) {
      await this.refresh();
      if (this.state !== "running") throw notRunning(this.id, this.state);
      try {
        return await run(await launcher.connectOverCDP(this.cdpUrl), attempt);
      } catch (error) {
        if (attempt >= maxReconnects || !isDisconnect(error)) throw error;
      }
      await sleep(delayMs * (attempt + 1));
    }
  }

  /** Hand the session to a person (`holder` names them in the audit log): agent input pauses until `giveBackControl()`. */
  async takeControl(holder?: string): Promise<Control> {
    const { data } = await takeBrowserControl({
      client: this.ctx.client,
      throwOnError: true,
      path: this.path,
      body: holder === undefined ? {} : { holder },
    });
    const control = data as Partial<Control>;
    return {
      cdp_url: control.cdp_url ?? "",
      control_id: control.control_id ?? "",
      ...(control.holder && { holder: control.holder }),
    };
  }

  /** End a person's control; agent input resumes. */
  async giveBackControl(): Promise<void> {
    await giveBackBrowserControl({ client: this.ctx.client, throwOnError: true, path: this.path });
  }

  /** Return who controls the browser right now. */
  async controlState(): Promise<Record<string, unknown>> {
    const { data } = await getBrowserControl({ client: this.ctx.client, throwOnError: true, path: this.path });
    return data;
  }

  /** Stop the browser. */
  async stop(): Promise<void> {
    await stopBrowser({ client: this.ctx.client, throwOnError: true, path: this.path });
  }

  /** `await using browser = ...` stops the browser at the end of the scope; one that is already gone is fine. */
  async [Symbol.asyncDispose](): Promise<void> {
    await ignoreNotFound(this.stop());
  }
}
