import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  compareCountRatchetCounts,
  runCountRatchet,
} from "../lib/count-ratchet.mts";

const labels = {
  baselineUpdated: "Example baseline updated",
  failedToReadBaseline: "[example] Failed to read baseline",
  missingBaseline: "[example] Missing baseline",
  increased: "Example count increased",
  ok: "Example count",
  countNoun: "calls",
};

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writable() {
  let value = "";
  return {
    stream: { write: (chunk: string) => (value += chunk) },
    text: () => value,
  };
}

describe("count ratchet", () => {
  it("compares per-file counts and treats malformed baseline counts as zero", () => {
    expect(compareCountRatchetCounts(
      { "a.ts": 2, "b.ts": 1 },
      { "a.ts": 2, "b.ts": "not-a-number" },
    )).toEqual([{ file: "b.ts", count: 1, baselineCount: 0 }]);
  });

  it("writes and subsequently validates a generic count baseline through injected streams", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-count-ratchet-"));
    temporaryDirectories.push(cwd);
    const stdout = writable();
    const stderr = writable();
    const options = {
      collectCounts: () => ({ "worker/example.ts": 2 }),
      baselinePath: "scripts/lib/example-baseline.json",
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      labels,
      remediation: "Use the example helper.",
    };

    expect(runCountRatchet({ ...options, updateBaseline: true })).toBe(0);
    expect(readFileSync(join(cwd, options.baselinePath), "utf8")).toBe('{\n  "worker/example.ts": 2\n}\n');
    expect(runCountRatchet(options)).toBe(0);
    expect(stdout.text()).toBe(
      "Example baseline updated (1 file entries).\nExample count: OK (2/2 calls at or below baseline)\n",
    );
    expect(stderr.text()).toBe("");
  });

  it("reports a missing baseline with injected labels", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-count-ratchet-"));
    temporaryDirectories.push(cwd);
    const stdout = writable();
    const stderr = writable();

    expect(runCountRatchet({
      collectCounts: () => ({ "worker/example.ts": 3 }),
      baselinePath: "missing.json",
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      labels,
      remediation: "Use the example helper.",
    })).toBe(1);
    expect(stderr.text()).toBe("[example] Missing baseline at missing.json. Run with --update-baseline.\n");
  });

  it("rejects a per-file increase despite a lower total without rewriting the baseline, and accepts decreases", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-count-ratchet-"));
    temporaryDirectories.push(cwd);
    const stderr = writable();
    const options = {
      collectCounts: () => ({ "a.ts": 2, "b.ts": 10 }),
      baselinePath: "baseline.json", cwd, labels, remediation: "Reduce counts.",
      stdout: writable().stream, stderr: stderr.stream,
    };
    expect(runCountRatchet({ ...options, updateBaseline: true })).toBe(0);
    const baseline = readFileSync(join(cwd, options.baselinePath), "utf8");
    expect(runCountRatchet({ ...options, collectCounts: () => ({ "a.ts": 3, "b.ts": 1 }) })).toBe(1);
    expect(stderr.text()).toContain("a.ts: 3 > baseline 2");
    expect(stderr.text()).not.toContain("b.ts:");
    expect(readFileSync(join(cwd, options.baselinePath), "utf8")).toBe(baseline);
    expect(runCountRatchet({ ...options, collectCounts: () => ({ "a.ts": 1, "b.ts": 9 }) })).toBe(0);
    expect(readFileSync(join(cwd, options.baselinePath), "utf8")).toBe(baseline);
  });

  it.each(["{", "[]", "null"])("rejects invalid baseline %s without overwriting it", (baseline) => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-count-ratchet-"));
    temporaryDirectories.push(cwd);
    writeFileSync(join(cwd, "baseline.json"), baseline);
    const stderr = writable();
    expect(runCountRatchet({
      collectCounts: () => ({}), baselinePath: "baseline.json", cwd, labels,
      remediation: "Reduce counts.", stdout: writable().stream, stderr: stderr.stream,
    })).toBe(1);
    expect(stderr.text()).toContain(labels.failedToReadBaseline);
    expect(readFileSync(join(cwd, "baseline.json"), "utf8")).toBe(baseline);
  });
});
