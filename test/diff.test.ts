/**
 * Unit tests for the pure diffing helpers.
 */
import { describe, expect, test } from "bun:test";
import { classifyPrefix, commonPrefixCount, diffText } from "../src/diff";

describe("commonPrefixCount", () => {
  test("empty arrays", () => {
    expect(commonPrefixCount([], [])).toBe(0);
    expect(commonPrefixCount([], [1])).toBe(0);
    expect(commonPrefixCount([1], [])).toBe(0);
  });
  test("identical arrays", () => {
    expect(commonPrefixCount([1, 2, 3], [1, 2, 3])).toBe(3);
  });
  test("divergence at index k", () => {
    expect(commonPrefixCount([1, 2, 3, 4], [1, 2, 9, 4])).toBe(2);
  });
  test("equal objects compare by JSON (key order matters — wire bytes do)", () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(commonPrefixCount([a, 5], [a, 5])).toBe(2);
    expect(commonPrefixCount([a, 5], [b, 5])).toBe(0);
  });
});

describe("classifyPrefix", () => {
  const prev = [1, 2, 3];
  test("append: pure extension keeps the prefix intact", () => {
    expect(classifyPrefix(prev, [1, 2, 3, 4, 5])).toBe("append");
    expect(classifyPrefix(prev, [1, 2, 3])).toBe("append"); // identical
  });
  test("prefix-changed: a message inside the previous list differs", () => {
    expect(classifyPrefix(prev, [1, 2, 9, 4])).toBe("prefix-changed");
    expect(classifyPrefix(prev, [9, 2, 3, 4])).toBe("prefix-changed");
  });
  test("rewind: new list is a strict prefix of the old one", () => {
    expect(classifyPrefix(prev, [1, 2])).toBe("rewind");
    expect(classifyPrefix(prev, [])).toBe("rewind");
  });
  test("branch: new list is shorter AND differs", () => {
    expect(classifyPrefix(prev, [1, 9])).toBe("branch");
    expect(classifyPrefix(prev, [9])).toBe("branch");
  });
});

describe("diffText", () => {
  test("identical texts -> empty diff", () => {
    const d = diffText("a\nb\nc", "a\nb\nc");
    expect(d.text).toBe("");
    expect(d.blockDumped).toBe(false);
  });
  test("single-line change shows aligned -/+ lines", () => {
    const d = diffText("1\n2\n3", "1\nX\n3");
    expect(d.text).toContain("- 2");
    expect(d.text).toContain("+ X");
    expect(d.text).toContain("  1");
    expect(d.text).toContain("  3");
    expect(d.blockDumped).toBe(false);
  });
  test("pure append: only + lines, no - lines", () => {
    const d = diffText("1\n2", "1\n2\n3\n4");
    expect(d.text).not.toContain("- ");
    expect(d.text).toContain("+ 3");
    expect(d.text).toContain("+ 4");
  });
  test("pure deletion: only - lines, no + lines", () => {
    const d = diffText("1\n2\n3", "1");
    expect(d.text).not.toContain("+ ");
    expect(d.text).toContain("- 2");
    expect(d.text).toContain("- 3");
  });
  test("large unchanged prefix is collapsed into a counted marker", () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const d = diffText(big, big + "\nEND");
    expect(d.omittedPrefixLines).toBe(94); // 100 - 6 context lines
    expect(d.text).toContain("… 94 unchanged lines …");
    expect(d.text).toContain("+ END");
  });
  test("large unchanged suffix is collapsed into a counted marker", () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const d = diffText("START\n" + big, big);
    expect(d.omittedSuffixLines).toBe(94);
    expect(d.text).toContain("… 94 unchanged lines …");
    expect(d.text).toContain("- START");
  });
  test("huge change region falls back to a complete block dump", () => {
    const n = 2049; // 2049 x 2049 > 4_000_000
    const a = Array.from({ length: n }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: n }, (_, i) => `b${i}`).join("\n");
    const d = diffText(a, b);
    expect(d.blockDumped).toBe(true);
    expect(d.text).toContain("- a0");
    expect(d.text).toContain(`- a${n - 1}`);
    expect(d.text).toContain("+ b0");
    expect(d.text).toContain(`+ b${n - 1}`);
  });
  test("diff of two very different small texts is complete", () => {
    const d = diffText("x\ny", "p\nq");
    expect(d.blockDumped).toBe(false);
    expect(d.text).toContain("- x");
    expect(d.text).toContain("- y");
    expect(d.text).toContain("+ p");
    expect(d.text).toContain("+ q");
  });
});
