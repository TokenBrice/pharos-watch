import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { updateCriticalCoverageBaseline } from "../maintenance/update-critical-coverage-baseline.ts";
import { REBASELINE_MEASUREMENT_COMMAND, type CriticalCoverageRebaselineRecord } from "../lib/critical-coverage-rebaseline.mts";
import { mockExecFileSync, mockFsImpl, testEnv } from "../test-utils/ci-script-test-helpers";

const source = "worker/src/lib/auth.ts";
const recordPath = ".ci/critical-coverage-rebaseline/T2-INTEGRATE.json";
const baselinePath = ".ci/critical-coverage-baseline.json";
const now = new Date("2026-10-16T12:00:00Z");
const lcov = `SF:${source}\nDA:1,1\nLF:100\nLH:80\nBRF:10\nBRH:10\nend_of_record\n`;

function fixture() {
  const record: CriticalCoverageRebaselineRecord = {
    version: 1, waveId: "T2-INTEGRATE", baseSha: "a".repeat(40), candidateSha: "b".repeat(40),
    measurement: {
      command: REBASELINE_MEASUREMENT_COMMAND, baseLcovSha256: "c".repeat(64),
      candidateLcovSha256: createHash("sha256").update(lcov).digest("hex"), runUrl: null,
    },
    approvedBy: "owner", reviewer: "reviewer", approvedAt: "2026-10-16T10:00:00Z", transitionExpiresAt: "2026-11-01T00:00:00Z",
    entries: [{
      source, previousFloor: 90, measuredBefore: 90, measuredAfter: 80, newFloor: 80,
      configuredLineMinimum: 70, branchFloor: 40,
      removedTests: [{ path: "worker/src/lib/__tests__/auth.test.ts", titles: ["redundant input permutation"] }],
      survivingOwners: [{ path: "worker/src/lib/__tests__/auth.test.ts", title: "rejects unauthorized requests" }],
      protectedClass: "auth", rationale: "Remove repeated input permutations while retaining the authorization boundary.",
    }],
  };
  const baseline = JSON.stringify({ files: { [source]: 90 } });
  const files = new Map([["coverage/lcov.info", lcov], [baselinePath, baseline]]);
  const writeFileSync = vi.fn();
  const mkdirSync = vi.fn();
  const run = (argv: string[] = [], env: NodeJS.ProcessEnv = testEnv()) => {
    files.set(recordPath, JSON.stringify(record));
    updateCriticalCoverageBaseline({
      argv, env, criticalFiles: [source], now,
      fsImpl: {
        ...mockFsImpl({
          existsSync: (path) => files.has(path),
          readFileSync: (path) => files.get(path)!,
        }),
        mkdirSync, writeFileSync,
      },
      execFile: mockExecFileSync(() => baseline), consoleImpl: { log: vi.fn() },
    });
  };
  return { record, files, run, writeFileSync, mkdirSync };
}

describe("critical coverage baseline maintenance", () => {
  it("preserves existing floors in ordinary max-only maintenance", () => {
    const f = fixture();
    f.run();
    expect(JSON.parse(String(f.writeFileSync.mock.calls[0][1])).files).toEqual({ [source]: 90 });
  });

  it("lowers a floor only with a reviewed record matching the base and measured LCOV", () => {
    const f = fixture();
    f.run([`--rebaseline=${recordPath}`]);
    expect(JSON.parse(String(f.writeFileSync.mock.calls[0][1])).files).toEqual({ [source]: 80 });
  });

  it("uses the checker's fixed floors instead of retired per-file environment overrides", () => {
    const f = fixture();
    f.run([`--rebaseline=${recordPath}`], testEnv({
      CRITICAL_COVERAGE_THRESHOLD_AUTH: "0",
      CRITICAL_COVERAGE_BRANCH_THRESHOLD_AUTH: "0",
    }));
    expect(JSON.parse(String(f.writeFileSync.mock.calls[0][1])).files).toEqual({ [source]: 80 });
  });

  it.each([
    ["below minimum", (record: CriticalCoverageRebaselineRecord) => { record.entries[0].configuredLineMinimum = 60; }, "configuredLineMinimum"],
    ["without surviving owner", (record: CriticalCoverageRebaselineRecord) => { record.entries[0].survivingOwners = []; }, "surviving owner"],
    ["expired", (record: CriticalCoverageRebaselineRecord) => { record.transitionExpiresAt = "2026-10-16T11:00:00Z"; }, "expired"],
    ["unmeasured floor", (record: CriticalCoverageRebaselineRecord) => { record.entries[0].measuredAfter = 79; }, "equal measuredAfter"],
    ["changed branch floor", (record: CriticalCoverageRebaselineRecord) => { record.entries[0].branchFloor = 30; }, "branchFloor"],
    ["wrong LCOV", (record: CriticalCoverageRebaselineRecord) => { record.measurement.candidateLcovSha256 = "d".repeat(64); }, "candidateLcovSha256"],
    ["different base", (record: CriticalCoverageRebaselineRecord) => { record.entries[0].previousFloor = 95; }, "previousFloor"],
  ] as const)("fails closed before writes for a record %s", (_label, mutate, message) => {
    const f = fixture();
    mutate(f.record);
    expect(() => f.run([`--rebaseline=${recordPath}`])).toThrow(message);
    expect(f.writeFileSync).not.toHaveBeenCalled();
    expect(f.mkdirSync).not.toHaveBeenCalled();
  });

  it("rejects a floor below the checker's configured minimum", () => {
    const f = fixture();
    f.files.set("coverage/lcov.info", lcov.replace("LH:80", "LH:60"));
    f.record.entries[0].newFloor = 60;
    f.record.entries[0].measuredAfter = 60;
    expect(() => f.run([`--rebaseline=${recordPath}`])).toThrow("below the configured line minimum");
    expect(f.writeFileSync).not.toHaveBeenCalled();
  });

  it.each(["--unknown", "--rebaseline=", "--rebaseline=elsewhere.json"])("rejects invalid option %s before writes", (arg) => {
    const f = fixture();
    expect(() => f.run([arg])).toThrow();
    expect(f.writeFileSync).not.toHaveBeenCalled();
  });
});
