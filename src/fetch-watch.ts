/**
 * Wire-level observation for prefix-sentinel.
 *
 * Wraps globalThis.fetch so the sentinel sees EVERY HTTP request the pi
 * process sends — including the ones that bypass before_provider_request:
 *
 *   - pi's native compaction summary call
 *     (agent-session → compact → streamSimple; no onPayload on that path)
 *   - pi-vcc-plus summary and check requests (ModelRegistry.complete)
 *   - subagent / extension / provider-catalog requests
 *
 * The wire bytes are the source of truth for the prefix chain (the payload
 * hook only tracks cwd/model). A request aborted before fetch never touched
 * the server, so it correctly does not enter the chain.
 *
 * Reliability rules:
 *   - the wrapper is installed at most once per process; a re-import after
 *     /reload just swaps in the new observer (fresh in-memory state, disk
 *     state carries the chain across)
 *   - the original fetch is always called with the exact same arguments and
 *     its returned value is always handed back — observation can never
 *     delay, alter, or break the request
 *   - request bodies are observed, never consumed: a Request input is read
 *     via clone(), the original request is untouched
 *   - observations run in dispatch order on a microtask queue, fully
 *     detached from the request's fate; every failure is contained
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { classifyPrefix, commonPrefixCount, diffText } from "./diff";

const FORMAT = "wire-v1";
const DIR = ".pi/prefix-sentinel";
const LAST_NAME = "last-request.json";
const LOG_NAME = "log.jsonl";

export interface WireState {
  format: string;
  index: number;
  ts: number;
  modelId: string;
  raw: string; // exact wire body text — the source of truth
  pretty: string; // JSON.stringify(parsed, null, 2) — vcc-plus baseline compat
  messages: unknown[];
  toolsJson: string;
  systemJson: string | null;
  url: string;
}

export interface ObserverDeps {
  cwd: () => string;
  model: () => string;
  notify: (message: string) => void;
}

export interface Observer {
  observe(input: unknown, init?: unknown): void;
}

function dirFor(cwd: string): string {
  return join(cwd, DIR);
}
function logPathFor(cwd: string): string {
  return join(dirFor(cwd), LOG_NAME);
}
function lastPathFor(cwd: string): string {
  return join(dirFor(cwd), LAST_NAME);
}

/** host + pathname only (no query — may carry credentials). */
function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url.slice(0, 200);
  }
}

interface Described {
  url: string;
  method: string;
  /** Resolves to the exact wire body text, or null when unreadable. */
  getText: () => Promise<string | null>;
}

function describeRequest(input: unknown, init: unknown): Described {
  let url = "";
  let method = "GET";
  if (typeof input === "string" || input instanceof URL) {
    url = String(input);
    const i = init as Record<string, unknown> | undefined;
    if (i && typeof i === "object") {
      if (typeof i.method === "string") method = i.method;
      const body = i.body;
      if (typeof body === "string") {
        return { url, method, getText: async () => body };
      }
      try {
        if (body instanceof Uint8Array) {
          return { url, method, getText: async () => new TextDecoder("utf-8").decode(body) };
        }
        if (body instanceof ArrayBuffer) {
          return {
            url,
            method,
            getText: async () => new TextDecoder("utf-8").decode(new Uint8Array(body)),
          };
        }
        if (body != null && ArrayBuffer.isView(body)) {
          const v = body as DataView;
          return {
            url,
            method,
            getText: async () =>
              new TextDecoder("utf-8").decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)),
          };
        }
      } catch {
        /* unreadable → null */
      }
      return { url, method, getText: async () => null };
    }
    return { url, method, getText: async () => null };
  }
  if (input instanceof Request) {
    // Never read input.body directly — that would drain the request's own
    // stream and break the actual request. clone() is an independent copy.
    const req = input;
    return {
      url: req.url,
      method: req.method,
      getText: async () => {
        try {
          return await req.clone().text();
        } catch {
          return null; // not cloneable (unseekable stream) → skip the body
        }
      },
    };
  }
  return { url: String(input ?? ""), method, getText: async () => null };
}

export function createObserver(deps: ObserverDeps): Observer {
  let last: WireState | null = null;
  let index = 0;
  let diskAvailable = true;
  const startedAt = Date.now();
  let queue: Promise<void> = Promise.resolve();

  function appendLog(cwd: string, entry: Record<string, unknown>): void {
    if (!diskAvailable) return;
    try {
      mkdirSync(dirFor(cwd), { recursive: true });
      appendFileSync(logPathFor(cwd), JSON.stringify(entry) + "\n", "utf8");
    } catch {
      diskAvailable = false; // degrade: keep observing in memory only
    }
  }

  function writeLastAtomic(cwd: string, state: WireState): void {
    if (!diskAvailable) return;
    try {
      mkdirSync(dirFor(cwd), { recursive: true });
      const tmp = lastPathFor(cwd) + ".tmp";
      writeFileSync(tmp, JSON.stringify(state), "utf8");
      renameSync(tmp, lastPathFor(cwd));
    } catch {
      diskAvailable = false;
    }
  }

  type Loaded = { state: WireState | null; ignored: "none" | "legacy-format" };

  function loadLast(cwd: string): Loaded {
    try {
      const path = lastPathFor(cwd);
      if (!existsSync(path)) return { state: null, ignored: "none" };
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed?.format !== FORMAT || typeof parsed?.raw !== "string") {
        // Older payload-view state: byte format differs (pretty payload vs
        // wire body) — comparing against it would produce a false alarm.
        return { state: null, ignored: "legacy-format" };
      }
      return {
        state: {
          format: FORMAT,
          index: typeof parsed.index === "number" ? parsed.index : 0,
          ts: typeof parsed.ts === "number" ? parsed.ts : 0,
          modelId: String(parsed.modelId ?? "unknown"),
          raw: parsed.raw,
          pretty: typeof parsed.pretty === "string" ? parsed.pretty : "",
          messages: Array.isArray(parsed.messages) ? parsed.messages : [],
          toolsJson: typeof parsed.toolsJson === "string" ? parsed.toolsJson : "",
          systemJson: typeof parsed.systemJson === "string" ? parsed.systemJson : null,
          url: typeof parsed.url === "string" ? parsed.url : "",
        },
        ignored: "none",
      };
    } catch {
      return { state: null, ignored: "none" };
    }
  }

  function describe(
    classification: string,
    common: number,
    prevIndex: number,
    currIndex: number,
  ): string {
    const span = `request ${prevIndex} → ${currIndex}`;
    switch (classification) {
      case "prefix-changed":
        return `prefix-sentinel: wire prefix CHANGED at message #${common} (${span}) — cache prefix broken`;
      case "branch":
        return `prefix-sentinel: context BRANCHED at message #${common} (${span})`;
      case "rewind":
        return `prefix-sentinel: context REWOUND (${span})`;
      default:
        return `prefix-sentinel: prefix changed (${span})`;
    }
  }

  function record(parsed: Record<string, unknown>, raw: string, url: string): void {
    const cwd = deps.cwd();
    const pretty = JSON.stringify(parsed, null, 2);
    const messages: unknown[] = Array.isArray(parsed.messages) ? parsed.messages : [];
    const toolsJson = parsed.tools === undefined ? "" : JSON.stringify(parsed.tools);
    const systemJson = parsed.system === undefined ? null : JSON.stringify(parsed.system);
    const modelId =
      typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : deps.model();
    const hp = hostPath(url);

    const idx = ++index;
    const now = Date.now();
    const entry: Record<string, unknown> = {
      ts: now,
      process: startedAt,
      index: idx,
      source: "wire",
      url: hp,
      model: modelId,
      messages: messages.length,
      tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
    };

    const prev = last ? { state: last, ignored: "none" as const } : loadLast(cwd);
    if (prev.state) {
      const ps = prev.state;
      const common = commonPrefixCount(ps.messages, messages);
      const classification = classifyPrefix(ps.messages, messages);
      const toolsChanged = toolsJson !== ps.toolsJson;
      const systemChanged = systemJson !== ps.systemJson;
      const modelChanged = modelId !== ps.modelId;
      const changed =
        classification !== "append" || toolsChanged || systemChanged || modelChanged;
      const diff = diffText(ps.raw, raw);

      entry.prevIndex = ps.index;
      entry.crossRestart = last === null;
      entry.classification = classification;
      entry.commonPrefixMessages = common;
      entry.firstDivergentMessage =
        classification === "prefix-changed" || classification === "branch" ? common : null;
      entry.toolsChanged = toolsChanged;
      entry.systemChanged = systemChanged;
      entry.modelChanged = modelChanged;
      // KV-cache friendly: the new body is an extension of (append) or a
      // strict prefix of (rewind) the previous wire body with unchanged
      // setup — the server only prefills the new tail (or nothing).
      entry.kvReusable =
        (classification === "append" || classification === "rewind") &&
        !toolsChanged &&
        !systemChanged &&
        !modelChanged;
      entry.changed = changed;
      entry.diffOmittedContext = {
        prefix: diff.omittedPrefixLines,
        suffix: diff.omittedSuffixLines,
      };
      entry.diffBlockDumped = diff.blockDumped;
      entry.diffChars = diff.text.length;
      entry.diff = diff.text;

      // A model change is logged but not announced (usually intentional).
      const worthNotifying = classification !== "append" || toolsChanged || systemChanged;
      if (last !== null && worthNotifying) {
        deps.notify(describe(classification, common, ps.index, idx));
      } else if (
        last === null &&
        (toolsChanged || systemChanged || (classification !== "append" && common > 0))
      ) {
        // Cross-restart: a brand-new context (common === 0) is expected and
        // stays quiet; a continued context that diverged, or a changed setup,
        // is worth interrupting the user for.
        deps.notify(
          `prefix-sentinel: since the previous run — ${describe(classification, common, ps.index, idx).replace(/^prefix-sentinel: /, "")}`,
        );
      }
    } else {
      entry.first = true;
      if (prev.ignored === "legacy-format") entry.baselineIgnored = "legacy-format";
    }

    const state: WireState = {
      format: FORMAT,
      index: idx,
      ts: now,
      modelId,
      raw,
      pretty,
      messages,
      toolsJson,
      systemJson,
      url: hp,
    };
    appendLog(cwd, entry);
    writeLastAtomic(cwd, state);
    last = state;
  }

  function recordOther(url: string, method: string, bodyText: string | null): void {
    appendLog(deps.cwd(), {
      ts: Date.now(),
      process: startedAt,
      source: "other",
      method,
      url: hostPath(url),
      bodyChars: bodyText?.length ?? 0,
    });
  }

  function taskFor(input: unknown, init?: unknown): () => Promise<void> {
    const d = describeRequest(input, init);
    return async () => {
      const text = await d.getText();
      if (text === null) {
        recordOther(d.url, d.method, null);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        recordOther(d.url, d.method, text);
        return;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray((parsed as Record<string, unknown>).messages)
      ) {
        // Not a recognizable inference request (MCP, telemetry, …) —
        // counted, body not kept.
        recordOther(d.url, d.method, text);
        return;
      }
      record(parsed as Record<string, unknown>, text, d.url);
    };
  }

  return {
    observe(input: unknown, init?: unknown): void {
      const task = taskFor(input, init);
      // Serialize observations in dispatch order. Each link swallows its own
      // failure, so `queue` never rejects (no unhandled rejection) and a
      // failed observation never blocks the next one.
      queue = queue.then(async () => {
        try {
          await task();
        } catch {
          /* contained */
        }
      });
    },
  };
}

// One wrapper per process; the observer is swappable (module re-import after
// /reload gets a fresh observer with fresh in-memory state).
const MARK = Symbol.for("prefix-sentinel.fetchWatch");
let active: Observer | null = null;
let originalFetch: unknown = null;

export function installFetchWatch(deps: ObserverDeps): void {
  active = createObserver(deps);
  const g = globalThis as Record<symbol | string, unknown>;
  if (g[MARK]) return; // wrapper already installed — observer swapped above
  originalFetch = g.fetch;
  if (typeof originalFetch !== "function") {
    g[MARK] = true;
    return;
  }
  const original = originalFetch as (input: unknown, init?: unknown) => unknown;
  const wrapped = function (input: unknown, init?: unknown): unknown {
    const result = original.call(globalThis, input, init); // exact same call
    try {
      active?.observe(input, init);
    } catch {
      /* observation must never affect the request */
    }
    return result;
  };
  g.fetch = wrapped;
  g[MARK] = true;
}

/** Test-only: forget the wrapper bookkeeping (tests restore fetch themselves). */
export function __resetFetchWatchForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[MARK];
  active = null;
  originalFetch = null;
}
