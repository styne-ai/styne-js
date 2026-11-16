import { describe, expect, it } from "vitest";
import { CommandError, VmEndedError, type CommandEvent } from "../../src";
import { json, mockClient, BROWSER, VM } from "./helpers";

function sse(...frames: string[]): Response {
  return new Response(frames.join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("vm", () => {
  it("runs a command and returns the result", async () => {
    const { styne, calls } = mockClient([
      json(201, VM),
      json(200, { id: "cmd_1", state: "exited", exit_code: 0, stdout: "2\n", stderr: "" }),
    ]);
    const vm = await styne.vms.create();
    const r = await vm.run("python -c 'print(1+1)'", { cwd: "/app", timeout_seconds: 30 });
    expect(r).toMatchObject({ id: "cmd_1", state: "exited", exit_code: 0, stdout: "2\n", stderr: "" });
    expect(r.ok).toBe(true);
    expect(r.check()).toBe(r);
    expect(calls[1]!.url).toBe("https://api.test/v1/vms/vm_abc/commands");
    expect(JSON.parse(calls[1]!.body)).toEqual({ cmd: "sh", args: ["-c", "python -c 'print(1+1)'"], cwd: "/app", timeout_seconds: 30 });
    expect(calls[1]!.headers.get("x-sdk-timeout-ms")).toBeNull();
  });

  it("streams command output as events", async () => {
    const { styne, calls } = mockClient([
      json(201, VM),
      sse(
        'event: started\ndata: {"pid":7}\n\n',
        'event: stdout\ndata: {"data":"aGVsbG8="}\n\n',
        ": keepalive\n\n",
        'event: stderr\ndata: {"data":"d2Fybg=="}\n\n',
        'event: exit\ndata: {"exit_code":0}\nid: 4\n\n',
      ),
    ]);
    const vm = await styne.vms.create();
    const events = [];
    for await (const ev of vm.stream("make test")) events.push(ev);
    expect(events).toMatchObject([
      { type: "started", data: '{"pid":7}' },
      { type: "stdout", data: "hello" },
      { type: "stderr", data: "warn" },
      { type: "exit", data: '{"exit_code":0}', exit_code: 0, timed_out: false },
    ]);
    expect(JSON.parse(calls[1]!.body)).toEqual({ cmd: "sh", args: ["-c", "make test"], stream: true });
    expect(calls[1]!.headers.get("accept")).toBe("text/event-stream");
  });

  it("reads, writes, lists and deletes files", async () => {
    const { styne, calls } = mockClient([
      json(201, VM),
      new Response("print(1)", { status: 200 }),
      new Response(null, { status: 204 }),
      json(200, { data: [{ name: "x.py", path: "/app/x.py", type: "file", size: 8 }] }),
      new Response(null, { status: 204 }),
    ]);
    const vm = await styne.vms.create();
    expect(await vm.files.readText("/app/x.py")).toBe("print(1)");
    await vm.files.write("/app/y.py", "x = 1");
    expect((await vm.files.list("/app"))[0]!.name).toBe("x.py");
    await vm.files.delete("/app/x.py");
    expect(calls[1]!.url).toBe("https://api.test/v1/vms/vm_abc/files?path=%2Fapp%2Fx.py");
    expect(calls[2]).toMatchObject({ method: "PUT", body: "x = 1" });
    expect(calls[3]!.url).toContain("/files/list?path=%2Fapp");
    expect(calls[4]!.method).toBe("DELETE");
  });

  it("exposes ports, forks, snapshots and rewinds", async () => {
    const { styne, calls } = mockClient([
      json(201, VM),
      json(201, { port: 8080, url: "https://p.test", public: true }),
      json(201, { data: [{ ...VM, id: "vm_c1" }, { ...VM, id: "vm_c2" }] }),
      json(201, { id: "snap_1", name: "base" }),
      json(201, { id: "ckpt_1", label: "before" }),
      json(200, { ...VM, state: "paused" }),
    ]);
    const vm = await styne.vms.create();
    expect((await vm.ports.expose(8080, { public: true })).url).toBe("https://p.test");
    expect((await vm.fork({ count: 2 })).map((v) => v.id)).toEqual(["vm_c1", "vm_c2"]);
    expect((await vm.snapshot("base")).id).toBe("snap_1");
    const ck = await vm.checkpoints.create("before");
    await vm.rewind(ck);
    expect(vm.state).toBe("paused");
    expect(JSON.parse(calls[2]!.body)).toEqual({ count: 2 });
    expect(JSON.parse(calls[5]!.body)).toEqual({ checkpoint: "ckpt_1" });
  });

  it("pauses with a tier and kills on async dispose", async () => {
    const { styne, calls } = mockClient([json(201, VM), json(200, { ...VM, state: "paused", pause_tier: "standby" }), new Response(null, { status: 204 })]);
    const vm = await styne.vms.create();
    await vm.pause("standby");
    expect(vm.state).toBe("paused");
    await vm[Symbol.asyncDispose]();
    expect(JSON.parse(calls[1]!.body)).toEqual({ tier: "standby" });
    expect(calls[2]!.method).toBe("DELETE");
  });

  it("walks every page of a list", async () => {
    const { styne, calls } = mockClient([
      json(200, { data: [VM], next_cursor: "c2", has_more: true }),
      json(200, { data: [{ ...VM, id: "vm_2" }], next_cursor: null, has_more: false }),
    ]);
    const ids: string[] = [];
    for await (const vm of styne.vms.list()) ids.push(vm.id);
    expect(ids).toEqual(["vm_abc", "vm_2"]);
    expect(calls[1]!.url).toContain("cursor=c2");
  });
});

describe("browser", () => {
  it("exposes the CDP url and attaches a Playwright-style launcher", async () => {
    const { styne } = mockClient([json(201, BROWSER)]);
    const b = await styne.browsers.create({ region: "ash" });
    expect(b.cdpUrl).toBe("wss://cdp.test/br_abc?token=t");
    const seen: string[] = [];
    const handle = await b.connect({ connectOverCDP: (url) => (seen.push(url), Promise.resolve("browser")) });
    expect(handle).toBe("browser");
    expect(seen).toEqual([b.cdpUrl]);
  });

  it("takes and gives back control", async () => {
    const { styne, calls } = mockClient([json(201, BROWSER), json(200, { cdp_url: "wss://cdp.test/br_abc?control=c1", control_id: "c1" }), new Response(null, { status: 204 })]);
    const b = await styne.browsers.create();
    expect(await b.takeControl("alice")).toEqual({ cdp_url: "wss://cdp.test/br_abc?control=c1", control_id: "c1" });
    await b.giveBackControl();
    expect(JSON.parse(calls[1]!.body)).toEqual({ holder: "alice" });
    expect(calls[2]!.method).toBe("DELETE");
  });
});

describe("command details", () => {
  it("throws CommandError from check() on a non-zero exit", async () => {
    const { styne } = mockClient([json(201, VM), json(200, { id: "c", state: "exited", exit_code: 2, stdout: "", stderr: "boom" })]);
    const vm = await styne.vms.create();
    const r = await vm.run(["false"]);
    expect(r.ok).toBe(false);
    expect(() => r.check()).toThrow(CommandError);
  });

  it("keeps a multi-byte character split across frames whole", async () => {
    const e = new TextEncoder().encode("é");
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const { styne } = mockClient([
      json(201, VM),
      sse(
        `event: stdout\ndata: {"data":"${b64(e.slice(0, 1))}"}\n\n`,
        `event: stdout\ndata: {"data":"${b64(e.slice(1))}"}\n\n`,
        'event: exit\ndata: {"exit_code":null,"signal":9,"timed_out":false}\n\n',
      ),
    ]);
    const vm = await styne.vms.create();
    let text = "";
    let exit: CommandEvent | undefined;
    for await (const ev of vm.stream("printf é")) {
      if (ev.type === "stdout") text += ev.data;
      if (ev.type === "exit") exit = ev;
    }
    expect(text).toBe("é");
    expect(exit).toMatchObject({ exit_code: null, signal: 9 });
  });

  it("throws the typed error of a stream error event", async () => {
    const { styne } = mockClient([
      json(201, VM),
      sse('event: error\ndata: {"error":{"code":"vm_ended","status":410,"message":"gone","request_id":"r"}}\n\n'),
    ]);
    const vm = await styne.vms.create();
    const run = async () => {
      for await (const ev of vm.stream("x")) expect(ev).toBeDefined();
    };
    await expect(run()).rejects.toBeInstanceOf(VmEndedError);
  });

  it("parses CRLF split across chunks as one line break", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('event: started\r\ndata: {"pid":1}\r'));
        c.enqueue(enc.encode('\n\r\nevent: exit\r\ndata: {"exit_code":0}\r\n\r\n'));
        c.close();
      },
    });
    const { styne } = mockClient([json(201, VM), new Response(body, { status: 200 })]);
    const vm = await styne.vms.create();
    const types: string[] = [];
    for await (const ev of vm.stream("x")) types.push(ev.type);
    expect(types).toEqual(["started", "exit"]);
  });
});
