# styne-sdk

TypeScript SDK for the [Styne API](https://styne.ai): VMs and cloud browsers.

- ESM and CommonJS builds, full types, no runtime dependencies
- Node 20+, Bun and Deno
- Retries with jitter and `Retry-After`, idempotency keys on creates, typed errors that carry the request id

```sh
npm install styne-sdk
```

Set `STYNE_API_KEY`, or pass `apiKey` to the constructor.

Methods are camelCase. Objects that mirror the API (create parameters, run options, results, records) keep the
API's snake_case field names, so they match the API reference one to one.

## Run code in a VM

```ts
import { Styne } from "styne-sdk";

const styne = new Styne();

const vm = await styne.vms.create({ template: "code" });
try {
  const result = await vm.run("node -v");
  console.log(result.exit_code, result.stdout);
  result.check(); // throws CommandError unless the exit code is 0

  await vm.files.write("/app/hello.js", "console.log('hi')");
  for await (const ev of vm.stream("node /app/hello.js")) {
    if (ev.type === "stdout") process.stdout.write(ev.data);
  }

  const { url } = await vm.ports.expose(8080, { public: true });
  console.log(url);
} finally {
  await vm.kill();
}
```

With TypeScript 5.2+ (or Node 24), `await using vm = await styne.vms.create()` deletes the VM when the scope ends.

`vm.run()` waits as long as the command runs unless you pass `timeout_seconds`. A command is sent once and never
retried.

## Checkpoint, fork and snapshot

```ts
const vm = await styne.vms.create({ template: "code" });

const before = await vm.checkpoints.create("before-migration");
await vm.run("./migrate.sh");
await vm.rewind(before); // back to the checkpoint

const copies = await vm.fork({ count: 3 }); // three VMs from the current state
const snap = await vm.snapshot("base-ready");
await vm.pause("standby");
await vm.resume();

for (const copy of copies) await copy.kill();
await vm.kill();
await styne.snapshots.delete(snap.id);
```

## Drive a browser

```ts
import { chromium } from "playwright-core";

const browser = await styne.browsers.create({ region: "ash" });
try {
  const pw = await browser.connect(chromium); // chromium.connectOverCDP(browser.cdpUrl)
  const page = await pw.newPage();
  await page.goto("https://example.com");

  // Hand the session to a person (captcha, login), then take it back. `holder` names them in the audit log.
  const { cdp_url, control_id } = await browser.takeControl("alice@example.com");
  await browser.giveBackControl();
} finally {
  await browser.stop();
}
```

`browser.cdpUrl` is a `wss://` endpoint, so `puppeteer.connect({ browserWSEndpoint: browser.cdpUrl })` works too.

### Keep a session through a dropped socket

The browser, its pages and their state live on the server, so a closed CDP socket does not end the session.
`browser.withReconnect` reads the session again, connects again and calls your function again (up to 5 times by default):

```ts
const title = await browser.withReconnect(chromium, async (pw, attempt) => {
  const context = pw.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.newPage());
  if (attempt === 0) await page.goto("https://example.com");
  return page.title();
});
```

Start from `context.pages()`, not from a page object you kept. Options: `maxReconnects`, `delayMs`, `isDisconnect` (default `isSocketClosed`). `run` starts again from the top, so it must be safe to repeat, and it owns the
browser object it is given. Errors that are not a
closed socket are rethrown unchanged.

## Errors

Every error is a `StyneError`:

- `APIError` (the API answered with an error) carries `status`, `code`, `requestId`, `origin`, `details` and
  `retryAfterSeconds`. Subclasses: `InvalidArgumentError`, `IdempotencyMismatchError`, `AuthenticationError`,
  `PaymentRequiredError`, `PlanRequiredError`, `PermissionDeniedError`, `NotFoundError`, `VmEndedError`,
  `ConflictError`, `QuotaExceededError`, `RateLimitError`, `LimitConcurrentError`, `CapacityError`,
  `CommandTimeoutError`, `ServerError`.
- `APIConnectionError` (no answer arrived) and its subclass `APITimeoutError`.
- `CommandError` from `CommandResult.check()`.

```ts
import { LimitConcurrentError } from "styne-sdk";

try {
  await styne.vms.create();
} catch (err) {
  if (err instanceof LimitConcurrentError) console.error("too many VMs", err.requestId);
  else throw err;
}
```

## Options

```ts
new Styne({
  apiKey: "sty_live_...",   // default: STYNE_API_KEY
  region: "ams",            // "ash" (US East, default) or "ams" (Europe); also us-east, ashburn, eu, eu-central; default: STYNE_REGION
  baseUrl: "https://ash.api.styne.ai/v1", // overrides region; default: STYNE_BASE_URL
  maxRetries: 2,            // network errors, 408, 429, 5xx; commands and other non-idempotent calls are never retried
  timeoutMs: 60_000,        // wait for the response headers of one attempt
  fetch: customFetch,       // optional
});
```

## Generated core

`src/_generated` is produced from `spec/openapi.yaml` with `@hey-api/openapi-ts` (`npm run generate`) and is never edited by hand.
The hand-written layer in `src` adds retries, streaming, pagination and the resource classes above.
The generated types are re-exported as `Api` for anything the helpers do not cover.

## Develop

```sh
npm install
npm run check   # typecheck, lint, unit tests, build
```

Live tests run against a real account: `STYNE_API_KEY=... npm run test:live`.

## License

Apache-2.0
