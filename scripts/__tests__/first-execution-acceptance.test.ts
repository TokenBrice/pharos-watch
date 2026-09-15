import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateFirstExecutionAcceptance, runFirstExecutionAcceptanceCli } from "../lib/first-execution-acceptance.mts";

const run = { startedAt: 1_800_000_010, durationMs: 1_000, status: "ok",
  metadata: { workerVersion: "exact-version", syncStartSec: 1_800_000_010, cacheWriteMode: "published" } };
const input = { job: "sync-stablecoins", workerVersion: "exact-version", notBefore: 1_800_000_000,
  status: { timestamp: 1_800_000_100, crons: { "sync-stablecoins": { lastRun: run } } } };
const withRun = (lastRun: unknown) => ({ ...input, status: { ...input.status, crons: { "sync-stablecoins": { lastRun } } } });

describe("collected execution acceptance", () => {
  it("accepts a completed matching execution without claiming publication", () => {
    expect(evaluateFirstExecutionAcceptance(input)).toEqual({ outcome: "passed", reason: "execution-confirmed" });
  });
  it.each([null, { ...run, metadata: null }, { ...run, metadata: { workerVersion: "old" } },
    { ...run, metadata: { workerVersion: "newer-unrelated" } }, { ...run, startedAt: input.notBefore - 1 },
    { ...run, durationMs: null }, { ...run, durationMs: -1 }, { ...run, durationMs: Infinity },
    { ...run, durationMs: 999_999 }, { ...run, startedAt: NaN }, { ...run, status: "running" },
    { ...run, status: "skipped" }, { ...run, status: "deferred" }, { ...run, status: null },
  ])("keeps incomplete or mismatched evidence pending: %j", (lastRun) => {
    expect(evaluateFirstExecutionAcceptance(withRun(lastRun)).outcome).toBe("pending");
  });
  it.each(["error", "failed", "degraded"])("fails a matching completed %s run", (status) => {
    expect(evaluateFirstExecutionAcceptance(withRun({ ...run, status })).outcome).toBe("failed");
  });
  it("does not use status timestamp or other-job success as deployment identity", () => {
    expect(evaluateFirstExecutionAcceptance({ ...input, job: "other-job" }).outcome).toBe("pending");
    expect(evaluateFirstExecutionAcceptance({ ...input, status: null }).outcome).toBe("pending");
  });
  it("derives required publication generation from the run and checks the visible payload", () => {
    const publication = { _meta: { updatedAt: run.metadata.syncStartSec } };
    expect(evaluateFirstExecutionAcceptance({ ...input, publishedStablecoins: publication })).toEqual({ outcome: "passed", reason: "execution-and-publication-confirmed" });
    for (const publishedStablecoins of [null, {}, { _meta: { updatedAt: run.metadata.syncStartSec - 1 } }, { _meta: { updatedAt: run.metadata.syncStartSec + 1 } }]) {
      expect(evaluateFirstExecutionAcceptance({ ...input, publishedStablecoins }).outcome).toBe("pending");
    }
    expect(evaluateFirstExecutionAcceptance({ ...input, requirePublication: true }).outcome).toBe("pending");
    expect(evaluateFirstExecutionAcceptance({ ...withRun({ ...run, metadata: { workerVersion: "exact-version" } }), publishedStablecoins: publication }).outcome).toBe("pending");
  });
  it("requires explicit publication proof even if the visible generation coincides", () => {
    const publishedStablecoins = { _meta: { updatedAt: run.metadata.syncStartSec } };
    for (const metadata of [
      { ...run.metadata, cacheWriteMode: undefined },
      { ...run.metadata, cacheWriteMode: "no-write" },
      { ...run.metadata, cacheWriteMode: "skipped-newer" },
      { ...run.metadata, cacheWriteSucceeded: false },
    ]) {
      expect(evaluateFirstExecutionAcceptance({ ...withRun({ ...run, metadata }), publishedStablecoins }))
        .toEqual({ outcome: "pending", reason: "publication-write-unconfirmed" });
    }
    // Compacted metadata retains the publication mode but may omit the boolean.
    expect(evaluateFirstExecutionAcceptance({ ...input, publishedStablecoins }).outcome).toBe("passed");
    expect(evaluateFirstExecutionAcceptance({ ...withRun({ ...run, metadata: { ...run.metadata, cacheWriteSucceeded: true } }), publishedStablecoins }).outcome).toBe("passed");
  });

  it("rejects malformed acceptance targets", () => {
    for (const notBefore of [0, NaN, Infinity, 1.5]) expect(() => evaluateFirstExecutionAcceptance({ ...input, notBefore })).toThrow();
    expect(() => evaluateFirstExecutionAcceptance({ ...input, workerVersion: "" })).toThrow();
  });
  it("CLI boundary reports usage errors with exit two and no saved payload", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/lib/first-execution-acceptance.mts", "--unexpected"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("Acceptance input is invalid or unreadable. Use --help for required arguments.\n");
    expect(result.stdout).toBe("");
  });

  it("CLI reads saved evidence and returns explicit outcome exit codes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-acceptance-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const path = join(dir, "status.json");
      const args = ["--status", path, "--job", input.job, "--worker-version", input.workerVersion, "--not-before", String(input.notBefore)];
      writeFileSync(path, JSON.stringify(input.status));
      expect(runFirstExecutionAcceptanceCli(args)).toBe(0);
      expect(runFirstExecutionAcceptanceCli([...args, "--require-publication"])).toBe(2);
      writeFileSync(path, JSON.stringify(withRun({ ...run, status: "error" }).status));
      expect(runFirstExecutionAcceptanceCli(args)).toBe(1);
      expect(() => runFirstExecutionAcceptanceCli([...args, "--unexpected"])).toThrow();
      expect(() => runFirstExecutionAcceptanceCli([...args, "--job", input.job])).toThrow();
    } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
});
