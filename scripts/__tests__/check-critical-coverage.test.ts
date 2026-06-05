import { describe, expect, it } from "vitest";

import {
  getChangedFilesFromGit,
  isAllZeroSha,
  parseChangedFilesFromEnv,
  runCriticalCoverageCompletenessGuard,
  runCriticalCoverageCheck,
} from "../ci/check-critical-coverage.mjs";
import {
  CRITICAL_COVERAGE_WAIVERS,
  CRITICAL_FILES,
  collectCriticalCoverageCandidates,
  findCriticalCoverageCandidatesMissingEnrollment,
  validateCriticalCoverageWaiverMetadata,
} from "../lib/critical-coverage.mjs";

describe("critical coverage changed-file detection", () => {
  it("parses explicit changed files before falling back to git", () => {
    expect(
      parseChangedFilesFromEnv({
        CRITICAL_COVERAGE_CHANGED_FILES: "worker\\src\\api\\status.ts, docs/testing.md\n\n",
      }),
    ).toEqual(["worker/src/api/status.ts", "docs/testing.md"]);
  });

  it("skips empty and all-zero compare refs", () => {
    expect(isAllZeroSha("0000000000000000000000000000000000000000")).toBe(true);
    expect(getChangedFilesFromGit("")).toEqual([]);
    expect(getChangedFilesFromGit("0000000000000000000000000000000000000000")).toEqual([]);
  });

  it("passes malicious-looking compare refs to git diff as a single argument", () => {
    const calls: unknown[] = [];
    const execFile = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return "worker\\src\\api\\status.ts\n";
    };

    expect(
      getChangedFilesFromGit("origin/main; touch /tmp/should-not-run", { execFile }),
    ).toEqual(["worker/src/api/status.ts"]);
    expect(calls).toEqual([
      ["git", ["diff", "--name-only", "origin/main; touch /tmp/should-not-run...HEAD"]],
    ]);
  });

  it("returns no changed files when git diff fails", () => {
    const warnings: string[] = [];
    const execFile = () => {
      throw new Error("bad ref");
    };

    expect(
      getChangedFilesFromGit("bad-ref", {
        execFile,
        consoleImpl: {
          warn: (message: string) => warnings.push(message),
        },
      }),
    ).toEqual([]);
    expect(warnings[0]).toContain('Could not diff against ref "bad-ref"');
  });

  it("derives high-stakes pricing, depeg, and reserve candidates from source prefixes", () => {
    const candidates = collectCriticalCoverageCandidates({
      sourceFiles: [
        "worker/src/cron/sync-stablecoins/new-price-path.ts",
        "worker/src/cron/depeg-detection/new-decision-helper.ts",
        "worker/src/cron/sync-live-reserves-new-helper.ts",
        "worker/src/lib/live-reserves-store-extra.ts",
        "worker/src/lib/depeg-resolver-store-validators.ts",
        "worker/src/lib/price-consensus.ts",
        "worker/src/lib/pricing-types.ts",
        "worker/src/cron/depeg-detection/types.ts",
        "worker/src/cron/sync-stablecoins/__tests__/new-price-path.test.ts",
        "worker/src/cron/daily-digest.ts",
      ],
    });

    expect(candidates).toEqual([
      "worker/src/cron/depeg-detection/new-decision-helper.ts",
      "worker/src/cron/sync-live-reserves-new-helper.ts",
      "worker/src/cron/sync-stablecoins/new-price-path.ts",
      "worker/src/lib/depeg-resolver-store-validators.ts",
      "worker/src/lib/live-reserves-store-extra.ts",
      "worker/src/lib/price-consensus.ts",
    ]);
  });

  it("flags high-stakes candidates without enrollment or explicit waiver", () => {
    const candidateFiles = [
      "worker/src/cron/sync-stablecoins/enrolled.ts",
      "worker/src/cron/sync-stablecoins/waived.ts",
      "worker/src/cron/sync-stablecoins/missing.ts",
    ];

    expect(
      findCriticalCoverageCandidatesMissingEnrollment(candidateFiles, {
        criticalFiles: ["worker/src/cron/sync-stablecoins/enrolled.ts"],
        waivers: {
          "worker/src/cron/sync-stablecoins/waived.ts": {
            disposition: "covered-by-enrolled-entrypoint",
            owner: "platform",
            createdAt: "2026-06-05",
            reason: "covered elsewhere",
          },
        },
      }),
    ).toEqual(["worker/src/cron/sync-stablecoins/missing.ts"]);
  });

  it("validates waiver metadata and rejects waivers for enrolled files", () => {
    expect(
      validateCriticalCoverageWaiverMetadata(
        {
          "worker/src/lib/price-consensus.ts": {
            disposition: "covered-by-enrolled-entrypoint",
            owner: "platform",
            createdAt: "2026-06-05",
            reason: "covered elsewhere",
          },
        },
        {
          candidateFiles: ["worker/src/lib/price-consensus.ts"],
          criticalFiles: ["worker/src/lib/price-consensus.ts"],
        },
      ),
    ).toEqual(["worker/src/lib/price-consensus.ts: already enrolled in critical coverage; remove waiver"]);

    expect(
      validateCriticalCoverageWaiverMetadata(
        {
          "worker/src/lib/new-price-helper.ts": {
            disposition: "unknown",
            owner: "",
            createdAt: "not-a-date",
            reason: "",
          },
        },
        {
          candidateFiles: ["worker/src/lib/new-price-helper.ts"],
          criticalFiles: [],
        },
      ),
    ).toEqual([
      'worker/src/lib/new-price-helper.ts: invalid waiver disposition "unknown"',
      "worker/src/lib/new-price-helper.ts: missing waiver reason",
      "worker/src/lib/new-price-helper.ts: missing waiver owner",
      "worker/src/lib/new-price-helper.ts: missing or invalid waiver createdAt",
    ]);
  });

  it("fails the checker when a high-stakes candidate lacks enrollment or waiver", () => {
    const errors: string[] = [];
    const exits: number[] = [];

    expect(
      runCriticalCoverageCompletenessGuard({
        candidateFiles: ["worker/src/cron/sync-stablecoins/new-price-path.ts"],
        criticalFiles: [],
        waivers: {},
        consoleImpl: {
          error: (message: string) => errors.push(message),
        },
        exit: (code: number) => {
          exits.push(code);
        },
      }),
    ).toBe(false);

    expect(exits).toEqual([1]);
    expect(errors).toContain("[coverage] Critical coverage candidate completeness failed.");
    expect(errors).toContain("[coverage] High-stakes candidates missing critical coverage enrollment or waiver:");
    expect(errors).toContain("  worker/src/cron/sync-stablecoins/new-price-path.ts");
  });

  it("keeps the checked-in high-stakes candidate set enrolled or explicitly waived", () => {
    const candidates = collectCriticalCoverageCandidates();

    expect(validateCriticalCoverageWaiverMetadata(CRITICAL_COVERAGE_WAIVERS, { candidateFiles: candidates })).toEqual([]);
    expect(findCriticalCoverageCandidatesMissingEnrollment(candidates)).toEqual([]);
  });

  it("ratchets all critical files when CRITICAL_COVERAGE_RATCHET_ALL is enabled", () => {
    const lcov = CRITICAL_FILES.map((file) => [
      `SF:${file}`,
      "DA:1,1",
      "DA:2,1",
      "LF:2",
      "LH:2",
      "end_of_record",
    ].join("\n")).join("\n");
    const baseline = {
      files: Object.fromEntries(CRITICAL_FILES.map((file) => [file, 100])),
    };
    const logs: string[] = [];
    const errors: string[] = [];
    const files = new Map<string, string>([
      ["coverage/lcov.info", lcov],
      [".ci/critical-coverage-baseline.json", JSON.stringify(baseline)],
    ]);
    const exits: number[] = [];

    runCriticalCoverageCheck({
      env: {
        CRITICAL_COVERAGE_CHANGED_FILES: CRITICAL_FILES[0],
        CRITICAL_COVERAGE_RATCHET_ALL: "1",
      },
      fsImpl: {
        existsSync: (path: string) => files.has(path),
        readFileSync: (path: string) => {
          const value = files.get(path);
          if (value == null) throw new Error(`missing ${path}`);
          return value;
        },
      },
      execFile: () => "",
      consoleImpl: {
        log: (message: string) => logs.push(message),
        error: (message: string) => errors.push(message),
        warn: (message: string) => logs.push(message),
      },
      exit: (code: number) => {
        exits.push(code);
      },
    });

    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
    expect(logs).toContain("[coverage] Ratchet targets: all critical files (CRITICAL_COVERAGE_RATCHET_ALL=1)");
    expect(logs.filter((line) => line.includes("RATCHET PASS"))).toHaveLength(CRITICAL_FILES.length);
  });
});
