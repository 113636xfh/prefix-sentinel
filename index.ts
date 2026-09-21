/**
 * prefix-sentinel — observation-only pi extension.
 *
 * Hooks `before_provider_request` — the exact wire body pi-ai builds for the
 * provider (system, tools, messages, model, …) — and compares every request
 * against the previous one, so that normal use over time reveals any prefix
 * change:
 *
 *   - only the LATEST full request text is kept on disk (overwritten each
 *     request, atomic write) — full texts are not appended forever
 *   - log.jsonl gets one line per request carrying the FULL diff against the
 *     previous full text plus a structured prefix classification
 *   - the request is never modified and the response never passes through
 *     this plugin (pi delivers provider responses to the agent directly)
 *
 * Reliability rules:
 *   - every failure is contained inside the handler: the agent flow is never
 *     affected, errors only produce a log line
 *   - disk write failures degrade to in-memory observation (notifications
 *     keep working); a temp-file + rename keeps last-request.json atomic
 *   - memory stays bounded: only the previous request's full text is kept
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyPrefix, commonPrefixCount, diffText } from "./src/diff";

const DIR = ".pi/prefix-sentinel";
const LAST_NAME = "last-request.json";
const LOG_NAME = "log.jsonl";

interface State {
  index: number;
  ts: number;
  modelId: string;
  pretty: string; // full text of the latest request (wire body, pretty JSON)
  messages: unknown[];
  toolsJson: string;
  systemJson: string | null;
}

let last: State | null = null;
let index = 0;
let diskAvailable = true;
const startedAt = Date.now();

function dirFor(cwd: string): string {
  return join(cwd, DIR);
}
function logPathFor(cwd: string): string {
  return join(dirFor(cwd), LOG_NAME);
}
function lastPathFor(cwd: string): string {
  return join(dirFor(cwd), LAST_NAME);
}

/** Full text of the previous process's last request (cross-restart diff). */
function loadLast(cwd: string): State | null {
  try {
    const path = lastPathFor(cwd);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed?.pretty !== "string") return null;
    return {
      index: typeof parsed.index === "number" ? parsed.index : 0,
      ts: typeof parsed.ts === "number" ? parsed.ts : 0,
      modelId: String(parsed.modelId ?? "unknown"),
      pretty: parsed.pretty,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      toolsJson: typeof parsed.toolsJson === "string" ? parsed.toolsJson : "",
      systemJson: typeof parsed.systemJson === "string" ? parsed.systemJson : null,
    };
  } catch {
    return null;
  }
}

function appendLog(cwd: string, entry: Record<string, unknown>): void {
  if (!diskAvailable) return;
  try {
    mkdirSync(dirFor(cwd), { recursive: true });
    appendFileSync(logPathFor(cwd), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    diskAvailable = false; // degrade: keep observing in memory only
  }
}

function writeLastAtomic(cwd: string, state: State): void {
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

function notify(ctx: unknown, message: string): void {
  try {
    const c = ctx as { hasUI?: boolean; ui?: { notify?: (m: string, t?: string) => void } };
    if (c?.hasUI && typeof c.ui?.notify === "function") {
      c.ui.notify(message, "warning");
    }
  } catch {
    /* observation only — never disturb the agent */
  }
}

function modelIdOf(payload: Record<string, unknown>, ctx: unknown): string {
  const c = ctx as { model?: { provider?: string; id?: string } };
  const fromPayload = typeof payload.model === "string" ? payload.model : "";
  const fromCtx = `${c?.model?.provider ?? ""}/${c?.model?.id ?? "unknown"}`;
  return fromPayload || fromCtx;
}

function describe(classification: string, common: number, prevIndex: number, currIndex: number): string {
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

function handle(event: unknown, ctx: unknown): void {
  const ev = event as { payload?: unknown };
  const payload = ev?.payload;
  if (!payload || typeof payload !== "object") return; // nothing to observe
  const p = payload as Record<string, unknown>;
  // Every real provider body (Anthropic / OpenAI / Bedrock-as-Anthropic)
  // carries a messages array; anything else is not a recognizable request.
  if (!Array.isArray(p.messages)) return;

  const cwd = typeof (ctx as { cwd?: string })?.cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd();
  const pretty = JSON.stringify(p, null, 2);
  const messages: unknown[] = Array.isArray(p.messages) ? p.messages : [];
  const toolsJson = p.tools === undefined ? "" : JSON.stringify(p.tools);
  const systemJson = p.system === undefined ? null : JSON.stringify(p.system);
  const modelId = modelIdOf(p, ctx);

  const idx = ++index;
  const now = Date.now();
  const entry: Record<string, unknown> = {
    ts: now,
    process: startedAt,
    index: idx,
    model: modelId,
    messages: messages.length,
    tools: Array.isArray(p.tools) ? p.tools.length : 0,
  };

  const prev = last ?? loadLast(cwd);
  if (prev) {
    const common = commonPrefixCount(prev.messages, messages);
    const classification = classifyPrefix(prev.messages, messages);
    const toolsChanged = toolsJson !== prev.toolsJson;
    const systemChanged = systemJson !== prev.systemJson;
    const modelChanged = modelId !== prev.modelId;
    const changed =
      classification !== "append" || toolsChanged || systemChanged || modelChanged;
    const diff = diffText(prev.pretty, pretty);

    entry.prevIndex = prev.index;
    entry.crossRestart = last === null;
    entry.classification = classification;
    entry.commonPrefixMessages = common;
    entry.firstDivergentMessage =
      classification === "prefix-changed" || classification === "branch" ? common : null;
    entry.toolsChanged = toolsChanged;
    entry.systemChanged = systemChanged;
    entry.modelChanged = modelChanged;
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
      notify(ctx, describe(classification, common, prev.index, idx));
    } else if (
      last === null &&
      (toolsChanged || systemChanged || (classification !== "append" && common > 0))
    ) {
      // Cross-restart: a brand-new context (common === 0) is expected and
      // stays quiet; a continued context that diverged, or a changed setup,
      // is worth interrupting the user for.
      notify(ctx, `prefix-sentinel: since the previous run — ${describe(classification, common, prev.index, idx).replace(/^prefix-sentinel: /, "")}`);
    }
  } else {
    entry.first = true;
  }

  const state: State = {
    index: idx,
    ts: now,
    modelId,
    pretty,
    messages,
    toolsJson,
    systemJson,
  };
  appendLog(cwd, entry);
  writeLastAtomic(cwd, state);
  last = state;
}

export default function prefixSentinel(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event: unknown, ctx: unknown) => {
    try {
      handle(event, ctx);
    } catch (error) {
      // Contain every failure: log it, keep the agent flowing.
      try {
        const cwd = typeof (ctx as { cwd?: string })?.cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd();
        appendLog(cwd, {
          ts: Date.now(),
          process: startedAt,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
      } catch {
        /* last resort: stay silent, never break the agent */
      }
    }
  });
}
