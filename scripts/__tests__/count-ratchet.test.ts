import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
});
