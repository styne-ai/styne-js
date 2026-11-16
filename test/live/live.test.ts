import { chromium } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import { AuthenticationError, type CommandEvent, NotFoundError, Styne, type Vm } from "../../src";

const apiKey = process.env["STYNE_API_KEY"];

describe.skipIf(!apiKey)("live API", () => {
  const styne = new Styne();
  const cleanup: Vm[] = [];

  async function withVm<T>(fn: (vm: Vm) => Promise<T>): Promise<T> {
    const vm = await styne.vms.create({ template: "small", timeout_seconds: 300 });
    cleanup.push(vm);
    try {
      return await fn(vm);
    } finally {
      await vm.kill().catch(() => undefined);
    }
  }

  afterAll(async () => {
    await Promise.all(cleanup.map((vm) => vm.kill().catch(() => undefined)));
  });

  it("runs commands and streams output", () =>
    withVm(async (vm) => {
      const ok = await vm.run("echo hello");
      expect(ok.exit_code).toBe(0);
      expect(ok.stdout.trim()).toBe("hello");
      expect((await vm.run("exit 3")).exit_code).toBe(3);

      const events: CommandEvent[] = [];
      for await (const ev of vm.stream("echo out; echo err >&2")) events.push(ev);
      const text = (type: string) => events.filter((e) => e.type === type).map((e) => e.data).join("");
      expect(text("stdout")).toBe("out\n");
      expect(text("stderr")).toBe("err\n");
      expect(events[0]?.type).toBe("started");
      expect(events.at(-1)).toMatchObject({ type: "exit", exit_code: 0 });
    }));

  it("reads, writes, lists and deletes files", () =>
    withVm(async (vm) => {
      await vm.files.write("/tmp/live/a.txt", "data");
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
      await vm.files.write("/tmp/live/b.bin", bytes);
      expect(await vm.files.readText("/tmp/live/a.txt")).toBe("data");
      expect(await vm.files.read("/tmp/live/b.bin")).toEqual(bytes);
      expect((await vm.files.list("/tmp/live")).map((e) => e.name).sort()).toEqual(["a.txt", "b.bin"]);
      await vm.files.delete("/tmp/live/a.txt");
      expect((await vm.files.list("/tmp/live")).map((e) => e.name)).toEqual(["b.bin"]);
    }));

  it("exposes and hides ports", () =>
    withVm(async (vm) => {
      const port = await vm.ports.expose(8080);
      expect(port.url).toMatch(/^https:\/\/8080-/);
      expect((await vm.ports.list()).map((p) => p.port)).toEqual([8080]);
      await vm.ports.hide(8080);
      expect(await vm.ports.list()).toEqual([]);
    }));

  it("snapshots, starts from a snapshot and forks", () =>
    withVm(async (vm) => {
      await vm.files.write("/root/marker", "kept");
      const snap = await vm.snapshot("live-test");
      const snapId = snap.id ?? "";
      try {
        const restored = await styne.snapshots.start(snapId);
        cleanup.push(restored);
        try {
          expect(await restored.files.readText("/root/marker")).toBe("kept");
        } finally {
          await restored.kill();
        }
      } finally {
        await styne.snapshots.delete(snapId);
      }
      const forks = await vm.fork({ count: 1 });
      cleanup.push(...forks);
      try {
        expect(forks).toHaveLength(1);
        expect((await forks[0]?.run("cat /root/marker"))?.stdout).toBe("kept");
      } finally {
        await Promise.all(forks.map((f) => f.kill()));
      }
    }));

  it("pauses and resumes keeping state", () =>
    withVm(async (vm) => {
      await vm.run("echo persisted > /root/state");
      expect((await vm.pause()).state).toBe("paused");
      expect((await vm.resume()).state).toBe("running");
      expect((await vm.run("cat /root/state")).stdout.trim()).toBe("persisted");
    }));

  it("creates a browser, connects over CDP and takes control", async () => {
    const browser = await styne.browsers.create({ timeout_seconds: 300 });
    try {
      expect(browser.cdpUrl).toMatch(/^wss:\/\//);
      const attached = await browser.connect(chromium);
      try {
        const page = await attached.newPage();
        await page.goto("data:text/html,<title>live</title>");
        expect(await page.title()).toBe("live");
      } finally {
        await attached.close();
      }
      const control = await browser.takeControl("live-test");
      expect(control.cdp_url).toMatch(/^wss:\/\//);
      await browser.giveBackControl();
    } finally {
      await browser.stop();
    }
  });

  it("lists regions", async () => {
    expect((await styne.regions.list()).length).toBeGreaterThan(0);
  });

  it("throws typed errors", async () => {
    await expect(styne.vms.get("vm_does_not_exist")).rejects.toBeInstanceOf(NotFoundError);
    const bad = new Styne({ apiKey: "sk_invalid", maxRetries: 0 });
    await expect(bad.vms.list().next()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("replays a create with the same idempotency key", async () => {
    const key = `live-test-${crypto.randomUUID()}`;
    const create = () =>
      fetch("https://api.styne.ai/v1/vms", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey ?? ""}`, "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ template: "small", timeout_seconds: 120 }),
      }).then((r) => r.json() as Promise<{ id: string }>);
    const first = await create();
    try {
      expect((await create()).id).toBe(first.id);
    } finally {
      await (await styne.vms.get(first.id)).kill();
    }
  });
});
