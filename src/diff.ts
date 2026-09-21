/**
 * Pure helpers for comparing two provider request bodies.
 * No pi dependency — unit-testable in isolation.
 */

/** Longest common prefix (count) of two arrays, compared element-by-element via JSON. */
export function commonPrefixCount(a: readonly unknown[], b: readonly unknown[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && JSON.stringify(a[i]) === JSON.stringify(b[i])) i++;
  return i;
}

export type PrefixClassification =
  | "append"
  | "prefix-changed"
  | "rewind"
  | "branch";

/**
 * How the new message list relates to the previous one:
 *  - append:         every previous message is still identical at the same
 *                    index (pure extension — the wire prefix is intact and
 *                    the KV cache can be reused)
 *  - prefix-changed: some message inside the previous list differs → the
 *                    cache prefix is broken
 *  - rewind:         the new list is a strict prefix of the previous one
 *                    (truncation, e.g. /rewind)
 *  - branch:         the new list is shorter AND differs somewhere
 */
export function classifyPrefix(
  prev: readonly unknown[],
  curr: readonly unknown[],
): PrefixClassification {
  const common = commonPrefixCount(prev, curr);
  if (common >= prev.length) return "append";
  if (curr.length < prev.length) return common >= curr.length ? "rewind" : "branch";
  return "prefix-changed";
}

export interface DiffResult {
  /** Unified-style line diff: "  ctx" / "- old" / "+ new"; "" when identical. */
  text: string;
  /** true when the change region was too large for LCS and is shown as a block dump (still complete) */
  blockDumped: boolean;
  /** unchanged leading / trailing lines collapsed into counted markers in `text` */
  omittedPrefixLines: number;
  omittedSuffixLines: number;
}

const MAX_LCS_PRODUCT = 4_000_000; // ~2048 x 2048 cells → ~16 MB table
const CONTEXT_LINES = 6;

/**
 * Full line diff of two texts (pretty-printed JSON request bodies).
 *
 * The change region is always shown in full — never truncated. Only the
 * unchanged leading/trailing context is collapsed into a counted marker
 * (the full texts themselves are kept on disk, so nothing is lost).
 */
export function diffText(a: string, b: string): DiffResult {
  if (a === b) {
    return { text: "", blockDumped: false, omittedPrefixLines: 0, omittedSuffixLines: 0 };
  }
  const A = a.split("\n");
  const B = b.split("\n");
  const max = Math.min(A.length, B.length);

  let pre = 0;
  while (pre < max && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;

  const out: string[] = [];
  const preShown = Math.min(pre, CONTEXT_LINES);
  for (let i = 0; i < preShown; i++) out.push(`  ${A[i]}`);
  if (pre > preShown) out.push(`… ${pre - preShown} unchanged lines …`);

  const midA = A.slice(pre, A.length - suf);
  const midB = B.slice(pre, B.length - suf);
  const blockDumped = midA.length * midB.length > MAX_LCS_PRODUCT;
  if (blockDumped) {
    for (const line of midA) out.push(`- ${line}`);
    for (const line of midB) out.push(`+ ${line}`);
  } else {
    out.push(...lcsLines(midA, midB));
  }

  const sufShown = Math.min(suf, CONTEXT_LINES);
  if (suf > sufShown) out.push(`… ${suf - sufShown} unchanged lines …`);
  for (let i = B.length - sufShown; i < B.length; i++) out.push(`  ${B[i]}`);

  return {
    text: out.join("\n"),
    blockDumped,
    omittedPrefixLines: Math.max(0, pre - preShown),
    omittedSuffixLines: Math.max(0, suf - sufShown),
  };
}

/** Classic LCS line diff for the (bounded) change region. */
function lcsLines(A: string[], B: string[]): string[] {
  const n = A.length;
  const m = B.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w;
    const next = (i + 1) * w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] =
        A[i] === B[j] ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push(`  ${A[i]}`);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push(`- ${A[i]}`);
      i++;
    } else {
      out.push(`+ ${B[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${A[i++]}`);
  while (j < m) out.push(`+ ${B[j++]}`);
  return out;
}
