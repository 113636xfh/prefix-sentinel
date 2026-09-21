/**
 * Wrapper-mechanics tests for the wire observation layer:
 * pass-through fidelity, idempotent install, body extraction (string /
 * Uint8Array / Request-clone), "other" classification, and failure containment.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetFetchWatchForTests, installFetchWatch } from "../src/fetch-watch";

const scratch = mkdtempSync(join(tmpdir(), "sentinel-fw-"));
const cwd = join(scratch, "p");
const realFetch = globalThis.fetch;

let originalCalls: Array<{ input: unknown; init?: unknown }> = [];
const fake = (input: unknown, init?: unknown): unknown => {
  originalCalls.push({ input, init });
  return 7;
};
const flush = () => new Promise<void>((r) => setImmediate(r));
const logPath = join(cwd, ".pi", "prefix-sentinel", "log.jsonl");
function logLines(): Array<Record<string, unknown>> {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const notes: string[] = [];

beforeAll(() => {
  (globalThis as Record<string, unknown>).fetch = fake;
  installFetchWatch({ cwd: () => cwd, model: () => "m-ctx", notify: (m) => notes.push(m) });
});

test("wrapper passes exact args through and returns the original result", async () => {
  const init = { method: "POST", body: '{"model":"m","messages":[]}' };
  const r = (globalThis.fetch as (u: unknown, i?: unknown) => unknown)("http://x/a", init);
  expect(r).toBe(7);
  expect(originalCalls.length).toBe(1);
  expect(originalCalls[0]!.input).toBe("http://x/a");
  expect(originalCalls[0]!.init).toBe(init); // same object, untouched
  await flush();
  const l = logLines().at(-1)!;
  expect(l.source).toBe("wire");
  expect(l.model).toBe("m"); // from the body's own model field
});

test("re-install is idempotent: wrapper kept, observer swapped", () => {
  const wrapped = globalThis.fetch;
  installFetchWatch({ cwd: () => cwd, model: () => "m2", notify: () => {} });
  expect(globalThis.fetch).toBe(wrapped);
});

test("model falls back to the tracked ctx model when the body has none", async () => {
  (globalThis.fetch as (u: unknown, i?: unknown) => unknown)("http://x/b", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  });
  await flush();
  const l = logLines().at(-1)!;
  expect(l.model).toBe("m2"); // the swapped-in observer's deps
});

test("GET without body → 'other' line", async () => {
  const before = logLines().length;
  (globalThis.fetch as (u: unknown) => unknown)("http://x/c");
  await flush();
  expect(logLines().length).toBe(before + 1);
  expect(logLines().at(-1)!.source).toBe("other");
});

test("unparseable JSON body → 'other' line with bodyChars", async () => {
  (globalThis.fetch as (u: unknown, i?: unknown) => unknown)("http://x/d", {
    method: "POST",
    body: "not-json",
  });
  await flush();
  const l = logLines().at(-1)!;
  expect(l.source).toBe("other");
  expect(l.bodyChars).toBe(8);
});

test("Request body is read via clone; the original request stays readable", async () => {
  const body = { model: "m", messages: [{ role: "user", content: "hello" }] };
  const req = new Request("http://x/e", { method: "POST", body: JSON.stringify(body) });
  (globalThis.fetch as (u: unknown) => unknown)(req);
  await flush();
  const l = logLines().at(-1)!;
  expect(l.source).toBe("wire");
  expect(l.messages).toBe(1);
  expect(await req.text()).toBe(JSON.stringify(body)); // not drained
});

test("Uint8Array body is decoded", async () => {
  const body = { model: "m", messages: [{ role: "user", content: "u8" }] };
  (globalThis.fetch as (u: unknown, i?: unknown) => unknown)("http://x/f", {
    method: "POST",
    body: new TextEncoder().encode(JSON.stringify(body)),
  });
  await flush();
  const l = logLines().at(-1)!;
  expect(l.source).toBe("wire");
  expect(l.messages).toBe(1);
});

test("a throwing observer never breaks the request", async () => {
  installFetchWatch({
    cwd: () => {
      throw new Error("boom");
    },
    model: () => "m",
    notify: () => {},
  });
  let r: unknown;
  expect(() => {
    r = (globalThis.fetch as (u: unknown, i?: unknown) => unknown)("http://x/g", {
      method: "POST",
      body: '{"model":"m","messages":[]}',
    });
  }).not.toThrow();
  expect(r).toBe(7);
  await flush();
  // restore a sane observer
  installFetchWatch({ cwd: () => cwd, model: () => "m", notify: (m) => notes.push(m) });
});

afterAll(() => {
  __resetFetchWatchForTests();
  (globalThis as Record<string, unknown>).fetch = realFetch;
  rmSync(scratch, { recursive: true, force: true });
});
