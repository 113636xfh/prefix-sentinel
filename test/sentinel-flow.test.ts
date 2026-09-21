/**
 * End-to-end flow test: drives the real extension handler with fake requests
 * and verifies on-disk artifacts, notifications, and failure containment.
 *
 * "Processes" are fresh module instances (ESM cache bust via query string);
 * the shared cwd simulates the same project across restarts.
 *
 * Expected log (8 lines, in order):
 *   1 first            5 rewind (in-session)
 *   2 append           6 cross-restart, resumed intact (quiet)
 *   3 prefix-changed   7 cross-restart, system changed (new process)
 *   4 tools changed    8 error (stringify failure contained)
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "prefix-sentinel-flow-"));
const cwd = join(scratch, "proj");

interface Ui {
  notifs: string[];
}
interface Process {
  fire(payload: unknown, ui?: Ui): unknown;
}

async function loadFreshProcess(): Promise<Process> {
  const mod = await import(`../index.ts?p=${Date.now()}-${Math.random()}`);
  const handlers: Array<(e: unknown, c: unknown) => unknown> = [];
  mod.default({
    on: (_name: string, h: (e: unknown, c: unknown) => unknown) => {
      handlers.push(h);
    },
  });
  return {
    fire(payload: unknown, ui?: Ui) {
      return handlers[0]!({ type: "before_provider_request", payload }, {
        cwd,
        hasUI: true,
        ui: ui ? { notify: (m: string) => ui.notifs.push(m) } : { notify: () => {} },
        model: { provider: "p", id: "m" },
      });
    },
  };
}

function logLines(): Array<Record<string, unknown>> {
  const path = join(cwd, ".pi", "prefix-sentinel", "log.jsonl");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

function lastState(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, ".pi", "prefix-sentinel", "last-request.json"), "utf8"));
}

/** Entry n (1 = first line). */
function entry(n: number): Record<string, unknown> {
  const lines = logLines();
  return lines[n - 1]!;
}

const msg1 = { role: "user", content: "hello", timestamp: 1 };
const msg2 = { role: "assistant", content: "hi", timestamp: 2 };
const base = {
  model: "m",
  system: "SYS",
  tools: [{ name: "read", description: "d", input_schema: { type: "object" } }],
};

// Run the whole sequence first (top-level await runs before the tests).
const g = globalThis as Record<string, unknown>;
const driver = async () => {
  const p1 = await loadFreshProcess();
  g.p1 = p1;
  const ui1: Ui = { notifs: [] };

  p1.fire({ ...base, messages: [msg1] });
  p1.fire({ ...base, messages: [msg1, msg2] });
  p1.fire({ ...base, messages: [{ ...msg1, content: "HELLO" }, msg2] }, ui1); // notify
  p1.fire(
    { ...base, tools: [...base.tools, { name: "write" }] as unknown[], messages: [{ ...msg1, content: "HELLO" }, msg2] },
    ui1,
  ); // notify
  p1.fire(
    { ...base, tools: [...base.tools, { name: "write" }] as unknown[], messages: [{ ...msg1, content: "HELLO" }] },
    ui1,
  ); // notify (rewind)
  expect(ui1.notifs.length).toBe(3);
  for (const n of ui1.notifs) expect(n).toContain("prefix-sentinel");

  const p2 = await loadFreshProcess();
  const ui2: Ui = { notifs: [] };

  // resumed context: identical to p1's last request → quiet
  p2.fire(
    { ...base, tools: [...base.tools, { name: "write" }] as unknown[], messages: [{ ...msg1, content: "HELLO" }] },
    ui2,
  );
  expect(ui2.notifs.length).toBe(0);

  // A brand-new process starts with a changed system prompt → notified
  const p3 = await loadFreshProcess();
  const ui3: Ui = { notifs: [] };
  p3.fire(
    { ...base, system: "SYS2", tools: [...base.tools, { name: "write" }] as unknown[], messages: [{ ...msg1, content: "HELLO" }] },
    ui3,
  );
  expect(ui3.notifs.length).toBe(1);
  g.p3 = p3;

  // A further process: no-payload events stay silent
  const p4 = await loadFreshProcess();
  g.p4 = p4;

  // And a pathological payload (circular) is contained, never thrown
  const p5 = await loadFreshProcess();
  const circular: Record<string, unknown> = { model: "m", messages: [] };
  circular.self = circular; // makes JSON.stringify throw
  p5.fire(circular);
};
await driver();

test("request 1: logged as first, full text persisted", () => {
  const st = lastState();
  expect(entry(1).first).toBe(true);
  expect(entry(1).index).toBe(1);
  expect(st.pretty).toBe(JSON.stringify({ ...base, system: "SYS2", tools: [...base.tools, { name: "write" }] as unknown[], messages: [{ ...msg1, content: "HELLO" }] }, null, 2));
  expect(st.messages).toEqual([{ ...msg1, content: "HELLO" }]);
});

test("request 2: in-session pure append is quiet", () => {
  const l = entry(2);
  expect(l.classification).toBe("append");
  expect(l.changed).toBe(false);
  expect(l.crossRestart).toBe(false);
});

test("request 3: prefix change detected at message #0, notified, diff present", () => {
  const l = entry(3);
  expect(l.classification).toBe("prefix-changed");
  expect(l.firstDivergentMessage).toBe(0);
  expect(l.toolsChanged).toBe(false);
  expect(l.systemChanged).toBe(false);
  expect(l.changed).toBe(true);
  expect(typeof l.diff).toBe("string");
  expect((l.diff as string).length).toBeGreaterThan(0);
});

test("request 4: tools change flagged and notified on clean append", () => {
  const l = entry(4);
  expect(l.classification).toBe("append");
  expect(l.toolsChanged).toBe(true);
  expect(l.changed).toBe(true);
});

test("request 5: rewind classified and notified", () => {
  const l = entry(5);
  expect(l.classification).toBe("rewind");
  expect(l.changed).toBe(true);
});

test("request 6: cross-restart, resumed intact context is quiet", () => {
  const l = entry(6);
  expect(l.crossRestart).toBe(true);
  expect(l.classification).toBe("append");
  expect(l.changed).toBe(false);
});

test("request 7: cross-restart system change flagged and notified", () => {
  const l = entry(7);
  expect(l.crossRestart).toBe(true);
  expect(l.systemChanged).toBe(true);
  expect(l.changed).toBe(true);
});

test("no-payload events are ignored without throwing or logging", () => {
  const before = logLines().length;
  const p4 = g.p4 as Process;
  expect(() => p4.fire(undefined)).not.toThrow();
  expect(() => p4.fire(null)).not.toThrow();
  expect(() => p4.fire({})).not.toThrow();
  expect(logLines().length).toBe(before);
});

test("request 8: stringify failure contained, logged as an error line", () => {
  const l = entry(8);
  expect(typeof l.error).toBe("string");
  expect((l.error as string).length).toBeGreaterThan(0);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
