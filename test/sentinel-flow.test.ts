/**
 * End-to-end flow test, wire-driven: the sentinel observes through the
 * global fetch wrapper, exactly like it does inside pi.
 *
 * "Processes" are fresh module instances (ESM cache bust via query string);
 * the shared cwd simulates the same project across restarts. The fetch
 * wrapper itself is installed once and each fresh module swaps in its own
 * observer (fresh in-memory state, index counter restarts) — the same as a
 * real /reload or restart.
 *
 * Log line sequence (line numbers are global; `index` restarts per process):
 *   1 p1 req1 first           6 other (POST /health)
 *   2 p1 req2 append          7 other (GET /poll)
 *   3 p1 req3 prefix-changed  8 p2 req (cross-restart, resumed, quiet)
 *   4 p1 req4 tools changed   9 p3 req (cross-restart, system changed)
 *   5 p1 req5 rewind          10 p4 req (Request-input body, quiet)
 *   11 p5 req (added later: legacy baseline ignored)
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetFetchWatchForTests } from "../src/fetch-watch";

const scratch = mkdtempSync(join(tmpdir(), "prefix-sentinel-flow-"));
const cwd = join(scratch, "proj");
const URL = "http://127.0.0.1:9/v1/chat/completions";

const realFetch = globalThis.fetch;

interface CollectorCall {
  input: unknown;
  init?: unknown;
}
const calls: CollectorCall[] = [];
const collector = (input: unknown, init?: unknown): unknown => {
  calls.push({ input, init });
  return Promise.resolve(42);
};

interface Ui {
  notifs: string[];
}
interface Process {
  ui: Ui;
  /** fire the payload hook (cwd/model tracking) — pi does this just before fetch */
  track(payload?: unknown): void;
  /** drive a real fetch through the wrapper (url + init.body string) */
  req(url: string, body: unknown): Promise<unknown>;
  /** drive a real fetch with a Request input (body inside the Request) */
  reqWithRequest(req: Request): Promise<unknown>;
}

async function loadFreshProcess(): Promise<Process> {
  const mod = await import(`../index.ts?p=${Date.now()}-${Math.random()}`);
  let handler: ((e: unknown, c: unknown) => unknown) | null = null;
  const ui: Ui = { notifs: [] };
  mod.default({
    on: (_name: string, h: (e: unknown, c: unknown) => unknown) => {
      handler = h;
    },
  });
  return {
    ui,
    track(payload?: unknown) {
      handler!({ type: "before_provider_request", payload }, {
        cwd,
        hasUI: true,
        ui: { notify: (m: string) => ui.notifs.push(m) },
        model: { provider: "p", id: "m" },
      });
    },
    async req(url: string, body: unknown) {
      const s = typeof body === "string" ? body : JSON.stringify(body);
      return (globalThis.fetch as (u: unknown, i?: unknown) => unknown)(url, {
        method: "POST",
        body: s,
      });
    },
    async reqWithRequest(req: Request) {
      return (globalThis.fetch as (u: unknown) => unknown)(req);
    },
  };
}

/** Let the observation queue drain (microtasks). */
const flush = () => new Promise<void>((r) => setImmediate(r));

function logLines(): Array<Record<string, unknown>> {
  const path = join(cwd, ".pi", "prefix-sentinel", "log.jsonl");
  try {
    return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Log line n (1 = first line). */
function entry(n: number): Record<string, unknown> {
  const l = logLines()[n - 1];
  if (!l) throw new Error(`no log line ${n}`);
  return l;
}

function lastState(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(cwd, ".pi", "prefix-sentinel", "last-request.json"), "utf8"),
  );
}

const msg1 = { role: "user", content: "hello", timestamp: 1 };
const msg2 = { role: "assistant", content: "hi", timestamp: 2 };
const base = {
  model: "m",
  system: "SYS",
  tools: [{ name: "read", description: "d", input_schema: { type: "object" } }],
};
const tools2 = [...base.tools, { name: "write" }] as unknown[];
const g: Record<string, Process> = {};
let requestTextIntact = false;

// Run the whole sequence first (top-level await runs before the tests).
const driver = async () => {
  (globalThis as Record<string, unknown>).fetch = collector;

  const p1 = await loadFreshProcess();
  g.p1 = p1;

  const body1 = { ...base, messages: [msg1] };
  p1.track(body1);
  await p1.req(URL, body1);
  await flush();

  const body2 = { ...base, messages: [msg1, msg2] };
  p1.track(body2);
  await p1.req(URL, body2);
  await flush();

  const body3 = { ...base, messages: [{ ...msg1, content: "HELLO" }, msg2] };
  p1.track(body3);
  await p1.req(URL, body3);
  await flush();

  const body4 = { ...base, tools: tools2, messages: [{ ...msg1, content: "HELLO" }, msg2] };
  p1.track(body4);
  await p1.req(URL, body4);
  await flush();

  const body5 = { ...base, tools: tools2, messages: [{ ...msg1, content: "HELLO" }] };
  p1.track(body5);
  await p1.req(URL, body5);
  await flush();
  expect(p1.ui.notifs.length).toBe(3);
  for (const n of p1.ui.notifs) expect(n).toContain("prefix-sentinel");

  // Non-inference traffic: compact "other" lines, chain untouched.
  await p1.req("http://other.example/health", { ok: true });
  await (globalThis.fetch as (u: unknown) => unknown)("http://other.example/poll");
  await flush();

  const p2 = await loadFreshProcess();
  g.p2 = p2;
  // resumed context: identical to p1's last request → quiet
  p2.track(body5);
  await p2.req(URL, body5);
  await flush();
  expect(p2.ui.notifs.length).toBe(0);

  const p3 = await loadFreshProcess();
  g.p3 = p3;
  // brand-new process starts with a changed system prompt → notified
  const body7 = { ...base, system: "SYS2", tools: tools2, messages: [{ ...msg1, content: "HELLO" }] };
  p3.track(body7);
  await p3.req(URL, body7);
  await flush();
  expect(p3.ui.notifs.length).toBe(1);

  const p4 = await loadFreshProcess();
  g.p4 = p4;
  // Request input: the body lives inside the Request; the observer must read
  // it via clone() without draining the original.
  const body9 = {
    ...base,
    system: "SYS2",
    tools: tools2,
    messages: [{ ...msg1, content: "HELLO" }, { role: "user", content: "again", timestamp: 9 }],
  };
  p4.track(body9);
  const reqObj = new Request(URL, { method: "POST", body: JSON.stringify(body9) });
  await p4.reqWithRequest(reqObj);
  await flush();
  requestTextIntact = (await reqObj.text()) === JSON.stringify(body9);
};
await driver();

test("state file: exact wire raw + pretty + format", () => {
  const st = lastState();
  expect(st.format).toBe("wire-v1");
  // raw is the EXACT body text that went out (no re-serialization)
  const sent = JSON.stringify({
    ...base,
    system: "SYS2",
    tools: tools2,
    messages: [{ ...msg1, content: "HELLO" }, { role: "user", content: "again", timestamp: 9 }],
  });
  expect(st.raw).toBe(sent);
  expect(st.pretty).toBe(JSON.stringify(JSON.parse(sent), null, 2));
  expect(st.url).toBe("127.0.0.1:9/v1/chat/completions");
});

test("line 1: first request logged with source=wire and url", () => {
  const l = entry(1);
  expect(l.first).toBe(true);
  expect(l.source).toBe("wire");
  expect(l.url).toBe("127.0.0.1:9/v1/chat/completions");
  expect(l.model).toBe("m");
  expect(l.messages).toBe(1);
});

test("line 2: in-session pure append is quiet and KV-reusable", () => {
  const l = entry(2);
  expect(l.classification).toBe("append");
  expect(l.changed).toBe(false);
  expect(l.crossRestart).toBe(false);
  expect(l.kvReusable).toBe(true);
});

test("line 3: prefix change detected at message #0, notified", () => {
  const l = entry(3);
  expect(l.classification).toBe("prefix-changed");
  expect(l.firstDivergentMessage).toBe(0);
  expect(l.toolsChanged).toBe(false);
  expect(l.systemChanged).toBe(false);
  expect(l.kvReusable).toBe(false);
  expect(l.changed).toBe(true);
  expect(typeof l.diff).toBe("string");
  expect((l.diff as string).length).toBeGreaterThan(0);
});

test("line 4: tools change flagged and notified on clean append", () => {
  const l = entry(4);
  expect(l.classification).toBe("append");
  expect(l.toolsChanged).toBe(true);
  expect(l.kvReusable).toBe(false);
  expect(l.changed).toBe(true);
});

test("line 5: rewind classified, notified, but KV-reusable", () => {
  const l = entry(5);
  expect(l.classification).toBe("rewind");
  expect(l.kvReusable).toBe(true); // a strict prefix of the previous wire body
  expect(l.changed).toBe(true);
});

test("lines 6-7: non-inference requests are 'other' lines, chain untouched", () => {
  const health = entry(6);
  expect(health.source).toBe("other");
  expect(health.method).toBe("POST");
  expect(health.bodyChars).toBeGreaterThan(0);
  const poll = entry(7);
  expect(poll.source).toBe("other");
  expect(poll.method).toBe("GET");
  expect(poll.bodyChars).toBe(0);
  // chain continues from request 5 (index 5) — not from the 'other' lines
  expect(entry(8).prevIndex).toBe(5);
});

test("line 8: cross-restart, resumed intact context is quiet", () => {
  const l = entry(8);
  expect(l.crossRestart).toBe(true);
  expect(l.classification).toBe("append");
  expect(l.kvReusable).toBe(true);
  expect(l.changed).toBe(false);
});

test("line 9: cross-restart system change flagged and notified", () => {
  const l = entry(9);
  expect(l.crossRestart).toBe(true);
  expect(l.systemChanged).toBe(true);
  expect(l.changed).toBe(true);
});

test("line 10: Request-input body read via clone, original untouched", () => {
  const l = entry(10);
  expect(l.source).toBe("wire");
  expect(l.messages).toBe(2);
  expect(l.classification).toBe("append");
  expect(requestTextIntact).toBe(true);
});

test("payload events without a fetch write nothing", async () => {
  const before = logLines().length;
  g.p4.track(undefined);
  g.p4.track(null);
  g.p4.track({});
  await flush();
  expect(logLines().length).toBe(before);
});

test("legacy-format baseline is ignored and made visible", async () => {
  writeFileSync(
    join(cwd, ".pi", "prefix-sentinel", "last-request.json"),
    JSON.stringify({
      index: 99,
      ts: 1,
      modelId: "old",
      pretty: "{}",
      messages: [],
      toolsJson: "",
      systemJson: null,
    }),
  );
  const p5 = await loadFreshProcess();
  const body = { ...base, messages: [msg1] };
  p5.track(body);
  await p5.req(URL, body);
  await flush();
  const l = entry(11);
  expect(l.first).toBe(true);
  expect(l.baselineIgnored).toBe("legacy-format");
});

afterAll(() => {
  __resetFetchWatchForTests();
  (globalThis as Record<string, unknown>).fetch = realFetch;
  rmSync(scratch, { recursive: true, force: true });
});
