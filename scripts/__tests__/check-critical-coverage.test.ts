import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  captureProcessExit,
  mockConsole,
  mockExecFileSync,
  testEnv,
} from "../test-utils/ci-script-test-helpers";

import {
  CRITICAL_COVERAGE_BRANCH_FLOORS,
  getChangedFilesFromGit,
  isAllZeroSha,
  parseChangedFilesFromEnv,
  runCriticalCoverageCompletenessGuard,
} from "../ci/check-critical-coverage.ts";
import {
  CRITICAL_COVERAGE_WAIVERS,
  CRITICAL_FILES,
  collectCriticalCoverageCandidates,
  collectCriticalCoverageWaiverReviewQueue,
  findCriticalCoverageCandidatesMissingEnrollment,
  validateCriticalCoverageWaiverMetadata,
} from "../lib/critical-coverage.mjs";
import { buildCriticalLcov, runCoverageFixture } from "./check-critical-coverage.test-support";


describe("critical coverage changed-file detection", () => {
  it("parses explicit changed files before falling back to git", () => {
    expect(
      parseChangedFilesFromEnv(testEnv({
        CRITICAL_COVERAGE_CHANGED_FILES: "worker\\src\\api\\status.ts, docs/testing.md\n\n",
      })),
    ).toEqual(["worker/src/api/status.ts", "docs/testing.md"]);
  });

  it("skips empty and all-zero compare refs", () => {
    expect(isAllZeroSha("0000000000000000000000000000000000000000")).toBe(true);
    expect(getChangedFilesFromGit("")).toEqual([]);
    expect(getChangedFilesFromGit("0000000000000000000000000000000000000000")).toEqual([]);
  });

  it("passes malicious-looking compare refs to git diff as a single argument", () => {
    const calls: unknown[] = [];
    const execFile = mockExecFileSync((cmd, args) => {
      calls.push([cmd, args]);
      return "worker\\src\\api\\status.ts\0";
    });

    expect(
      getChangedFilesFromGit("origin/main; touch /tmp/should-not-run", { execFile }),
    ).toEqual(["worker/src/api/status.ts"]);
    expect(calls).toEqual([
      ["git", ["diff", "--name-only", "-z", "origin/main; touch /tmp/should-not-run...HEAD"]],
    ]);
  });

  it("throws when an explicit compare ref cannot be diffed", () => {
    const errors: string[] = [];
    const execFile = mockExecFileSync(() => {
      throw new Error("bad ref");
    });

    expect(
      () => getChangedFilesFromGit("bad-ref", {
        execFile,
        consoleImpl: mockConsole({
          error: (message: string) => errors.push(message),
        }),
      }),
    ).toThrow('Could not diff against explicit ref "bad-ref"');
    expect(errors[0]).toContain('Could not diff against explicit ref "bad-ref"');
  });

  it("fails closed when the configured compare ref cannot be diffed", () => {
    const { errors, exits, logs } = runCoverageFixture({
      env: { CRITICAL_COVERAGE_COMPARE_REF: "missing-ref" },
      lcov: "",
      baseline: { files: {} },
      execFile: mockExecFileSync(() => { throw new Error("unknown revision"); }),
    });

    expect(exits).toEqual([1]);
    expect(errors).toContainEqual(expect.stringContaining('Could not diff against explicit ref "missing-ref"'));
    expect(logs).not.toContain("[coverage] Critical coverage gate passed.");
  });

  it("derives high-stakes pricing, depeg, reserve, score, publication, and proxy candidates from source paths", () => {
    const candidates = collectCriticalCoverageCandidates({
      sourceFiles: [
        "functions/lib/upstream-proxy.ts",
        "functions/lib/csp-inject.ts",
        "shared/lib/peg-score.ts",
        "shared/lib/safety-score-version.ts",
        "shared/lib/psi-colors.ts",
        "worker/src/api/safety-score-history.ts",
        "worker/src/cron/sync-stablecoins/new-price-path.ts",
        "worker/src/cron/depeg-detection/new-decision-helper.ts",
        "worker/src/cron/sync-live-reserves-new-helper.ts",
        "worker/src/lib/mint-burn-scoring.ts",
        "worker/src/lib/live-reserves/store-extra.ts",
        "worker/src/lib/depeg-resolver-store-validators.ts",
        "worker/src/lib/price-consensus.ts",
        "worker/src/lib/publication-contract.ts",
        "worker/src/lib/pricing-types.ts",
        "worker/src/cron/depeg-detection/types.ts",
        "worker/src/cron/sync-stablecoins/__tests__/new-price-path.test.ts",
        "worker/src/cron/daily-digest.ts",
      ],
    });

    expect(candidates).toEqual([
      "functions/lib/upstream-proxy.ts",
      "shared/lib/peg-score.ts",
      "worker/src/api/safety-score-history.ts",
      "worker/src/cron/depeg-detection/new-decision-helper.ts",
      "worker/src/cron/sync-live-reserves-new-helper.ts",
      "worker/src/cron/sync-stablecoins/new-price-path.ts",
      "worker/src/lib/depeg-resolver-store-validators.ts",
      "worker/src/lib/live-reserves/store-extra.ts",
      "worker/src/lib/mint-burn-scoring.ts",
      "worker/src/lib/price-consensus.ts",
      "worker/src/lib/publication-contract.ts",
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
        waivers: { "worker/src/cron/sync-stablecoins/waived.ts": "2026-09-05" },
      }),
    ).toEqual(["worker/src/cron/sync-stablecoins/missing.ts"]);
  });

  it("fails completeness when an enrolled source has no importing owner", () => {
    const errors: string[] = [];
    const exits: number[] = [];

    expect(runCriticalCoverageCompletenessGuard({
      candidateFiles: ["worker/src/lib/new-critical-source.ts"],
      criticalFiles: ["worker/src/lib/new-critical-source.ts"],
      ownership: new Map(),
      ownershipWaivers: {},
      waivers: {},
      consoleImpl: mockConsole({
        error: (message: string) => errors.push(message),
      }),
      exit: captureProcessExit((code) => {
        if (code !== undefined) exits.push(code);
      }),
    })).toBe(false);

    expect(exits).toEqual([1]);
    expect(errors).toContain("[coverage] Enrolled critical sources missing importing owner tests:");
  });
  it("validates waiver metadata and rejects waivers for enrolled files", () => {
    expect(
      validateCriticalCoverageWaiverMetadata(
        { "worker/src/lib/price-consensus.ts": "2026-09-05" },
        {
          candidateFiles: ["worker/src/lib/price-consensus.ts"],
          criticalFiles: ["worker/src/lib/price-consensus.ts"],
        },
      ),
    ).toEqual(["worker/src/lib/price-consensus.ts: already enrolled in critical coverage; remove waiver"]);

    expect(
      validateCriticalCoverageWaiverMetadata(
        {
          "worker/src/lib/new-price-helper.ts": "not-a-date",
          "worker/src/lib/old-review-helper.ts": "2026-09-05",
        },
        {
          candidateFiles: ["worker/src/lib/new-price-helper.ts", "worker/src/lib/old-review-helper.ts"],
          criticalFiles: [],
        },
      ),
    ).toEqual([
      "worker/src/lib/new-price-helper.ts: missing or invalid waiver reviewAfter",
    ]);
  });

  it("reports overdue waiver reviews without failing the merge gate", () => {
    const waivers = {
      "worker/src/lib/overdue-price-helper.ts": "2026-06-10",
      "worker/src/lib/upcoming-price-helper.ts": "2026-06-30",
    };
    const candidateFiles = Object.keys(waivers);

    expect(
      collectCriticalCoverageWaiverReviewQueue(waivers, {
        candidateFiles,
        today: new Date("2026-06-20T00:00:00.000Z"),
        lookaheadDays: 14,
      }),
    ).toEqual({
      due: [{ file: "worker/src/lib/overdue-price-helper.ts", reviewAfter: "2026-06-10" }],
      upcoming: [{ file: "worker/src/lib/upcoming-price-helper.ts", reviewAfter: "2026-06-30" }],
    });

    const logs: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    expect(
      runCriticalCoverageCompletenessGuard({
        candidateFiles,
        criticalFiles: [],
        waivers,
        ownership: new Map(),
        ownershipWaivers: {},
        reviewToday: new Date("2026-06-20T00:00:00.000Z"),
        consoleImpl: mockConsole({
          error: (message: string) => errors.push(message),
          log: (message: string) => logs.push(message),
        }),
        exit: captureProcessExit((code) => {
          if (code !== undefined) exits.push(code);
        }),
      }),
    ).toBe(true);

    expect(exits).toEqual([]);
    expect(errors).toEqual([]);
    expect(logs).toContain("[coverage] Critical coverage waiver reviews due or overdue:");
    expect(logs).toContain("  worker/src/lib/overdue-price-helper.ts reviewAfter=2026-06-10");
    expect(logs).toContain("[coverage] Critical coverage waiver reviews due soon:");
  });

  it("fails the checker when a high-stakes candidate lacks enrollment or waiver", () => {
    const errors: string[] = [];
    const exits: number[] = [];

    expect(
      runCriticalCoverageCompletenessGuard({
        candidateFiles: ["worker/src/cron/sync-stablecoins/new-price-path.ts"],
        criticalFiles: [],
        waivers: {},
        ownership: new Map(),
        ownershipWaivers: {},
        consoleImpl: mockConsole({
          error: (message: string) => errors.push(message),
        }),
        exit: captureProcessExit((code) => {
          if (code !== undefined) exits.push(code);
        }),
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

  it("keeps every critical file represented in the checked-in ratchet baseline", () => {
    const baseline = JSON.parse(
      readFileSync(new URL("../../.ci/critical-coverage-baseline.json", import.meta.url), "utf8"),
    ) as { files: Record<string, unknown> };

    expect(CRITICAL_FILES.filter((file) => !Number.isFinite(baseline.files[file]))).toEqual([]);
  });

  it("ratchets all critical files when CRITICAL_COVERAGE_RATCHET_ALL is enabled", () => {
    const { logs, errors, exits } = runCoverageFixture({
      env: {
        CRITICAL_COVERAGE_CHANGED_FILES: CRITICAL_FILES[0],
        CRITICAL_COVERAGE_RATCHET_ALL: "1",
      },
      lcov: buildCriticalLcov(),
      baseline: { files: Object.fromEntries(CRITICAL_FILES.map((file) => [file, 100])) },
    });

    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
    expect(logs).toContain("[coverage] Ratchet targets: all critical files (CRITICAL_COVERAGE_RATCHET_ALL=1)");
    expect(logs.filter((line) => line.includes("RATCHET PASS"))).toHaveLength(CRITICAL_FILES.length);
  });

  it("limits per-file floor and missing checks to touched critical sources", () => {
    const file = "worker/src/lib/auth.ts";
    const lcov = [
      `SF:${file}`,
      "DA:1,1",
      "LF:1",
      "LH:1",
      "BRF:2",
      "BRH:2",
      "end_of_record",
    ].join("\n");
    const { logs, errors, exits } = runCoverageFixture({
      env: { CI: "1", CRITICAL_COVERAGE_CHANGED_FILES: file },
      lcov,
    });

    expect(exits).toEqual([]);
    expect(errors).toEqual([]);
    expect(logs).toContain("[coverage] PASS worker/src/lib/auth.ts: 100.0% (1/1) (threshold 70.0%)");
    expect(logs.some((line) => line.includes("MISSING:"))).toBe(false);
  });

  it.each(["source", "edited owner", "deleted owner"])("ratchets coverage regressions for a changed %s", (change) => {
    const file = "worker/src/lib/price-consensus.ts";
    const owner = change === "deleted owner" ? "worker/src/lib/__tests__/removed.test.ts" : "worker/src/lib/__tests__/price-consensus.test.ts";
    const { errors, exits } = runCoverageFixture({
      env: {
        CRITICAL_COVERAGE_CHANGED_FILES: change === "source" ? file : owner,
        ...(change === "deleted owner" ? { CRITICAL_COVERAGE_COMPARE_REF: "base" } : {}),
      },
      lcov: buildCriticalLcov({ lineCoverage: { [file]: { lf: 10, lh: 5 } } }),
      baseline: { files: { [file]: 51 } },
      execFile: mockExecFileSync((_cmd, args) => {
        if (args?.[0] === "ls-tree") return `${owner}\0${file}\0`;
        if (args?.[0] === "show") return 'import "../price-consensus";';
        throw new Error("Unexpected Git command");
      }),
    });

    expect(exits).toEqual([1]);
    expect(errors).toContain("[coverage] REGRESSION worker/src/lib/price-consensus.ts: 50.0% < baseline 51.0% (tolerance 0.0%)");
  });

  it.each([3, 4])("enforces the provider branch floor independently at %i/10 branches", (brh) => {
    const file = "worker/src/lib/evm-rpc.ts";
    const { errors, exits } = runCoverageFixture({
      env: { CRITICAL_COVERAGE_CHANGED_FILES: file },
      lcov: buildCriticalLcov({ branchCoverage: { [file]: { brf: 10, brh } } }),
      baseline: { files: { [file]: 100 } },
    });

    expect(exits).toEqual(brh < 4 ? [1] : []);
    expect(errors).toEqual(brh < 4 ? ["[coverage] BRANCH FAIL worker/src/lib/evm-rpc.ts: 30.0% (3/10) < 40.0%"] : []);
  });

  it("keeps branch/error-path floors at provider, auth, scoring, and publication boundaries", () => {
    expect(CRITICAL_COVERAGE_BRANCH_FLOORS).toEqual({
      "worker/src/lib/auth.ts": 40,
      "worker/src/lib/evm-rpc.ts": 40,
      "worker/src/lib/safety-scores.ts": 40,
      "worker/src/lib/price-publication-state.ts": 40,
    });
  });
});
