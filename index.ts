/**
 * prefix-sentinel — observation-only pi extension.
 *
 * Primary layer — wire observation (src/fetch-watch.ts): wraps globalThis.fetch
 * so EVERY HTTP request the process sends is observed at the wire (exact body
 * bytes). This covers requests that bypass before_provider_request:
 *   - pi's native compaction summary call (agent-session → compact → streamSimple)
 *   - pi-vcc-plus summary and check requests (ModelRegistry.complete)
 *   - subagent / extension / catalog requests
 * Inference-shaped bodies (JSON with a messages array) enter the prefix chain;
 * everything else gets a compact "other" log line (counted, body not kept).
 *
 * Secondary layer — before_provider_request: only tracks the current cwd and
 * model so wire entries can be labeled. It no longer records: the wire bytes
 * are the source of truth, and a request aborted before fetch never touched
 * the server, so it correctly does not enter the chain.
 *
 * Disk policy (per project cwd, `.pi/prefix-sentinel/`):
 *   - last-request.json: only the LATEST full wire body (overwritten atomically)
 *     — `raw` is the exact body text; `pretty` is kept for pi-vcc-plus's
 *     wire-baseline compatibility
 *   - log.jsonl: one line per request carrying the FULL diff against the
 *     previous wire body plus a structured prefix classification
 *
 * Reliability: the original fetch is always called with the same arguments
 * and its result is always returned; observation failures are contained;
 * disk failure degrades to in-memory observation. Zero runtime dependencies.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installFetchWatch } from "./src/fetch-watch";

let currentCwd: string | null = null;
let currentModel = "";
let lastCtx: unknown = null;

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

export default function prefixSentinel(pi: ExtensionAPI): void {
  installFetchWatch({
    cwd: () => currentCwd ?? process.cwd(),
    model: () => currentModel || "unknown",
    notify: (m) => notify(lastCtx, m),
  });
  pi.on("before_provider_request", (event: unknown, ctx: unknown) => {
    try {
      const c = ctx as { cwd?: string };
      if (typeof c?.cwd === "string") currentCwd = c.cwd;
      lastCtx = ctx;
      const payload = (event as { payload?: unknown })?.payload;
      if (payload && typeof payload === "object") {
        currentModel = modelIdOf(payload as Record<string, unknown>, ctx);
      }
    } catch {
      /* tracking only — never disturb the agent */
    }
  });
}
