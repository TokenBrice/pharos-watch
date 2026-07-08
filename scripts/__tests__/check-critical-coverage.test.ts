import { describe, expect, it } from "vitest";
import {
  captureProcessExit,
  mockConsole,
  mockExecFileSync,
  mockFsImpl,
  testEnv,
} from "../test-utils/ci-script-test-helpers";

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
  collectCriticalCoverageWaiverReviewQueue,
  findCriticalCoverageCandidatesMissingEnrollment,
  validateCriticalCoverageWaiverMetadata,
} from "../lib/critical-coverage.mjs";

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
      return "worker\\src\\api\\status.ts\n";
    });

    expect(
      getChangedFilesFromGit("origin/main; touch /tmp/should-not-run", { execFile }),
    ).toEqual(["worker/src/api/status.ts"]);
    expect(calls).toEqual([
      ["git", ["diff", "--name-only", "origin/main; touch /tmp/should-not-run...HEAD"]],
    ]);
  });

  it("returns no changed files when git diff fails", () => {
    const warnings: string[] = [];
    const execFile = mockExecFileSync(() => {
      throw new Error("bad ref");
    });

    expect(
      getChangedFilesFromGit("bad-ref", {
        execFile,
        consoleImpl: mockConsole({
          warn: (message: string) => warnings.push(message),
        }),
      }),
    ).toEqual([]);
    expect(warnings[0]).toContain('Could not diff against ref "bad-ref"');
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
        "worker/src/lib/live-reserves-store-extra.ts",
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
      "worker/src/lib/live-reserves-store-extra.ts",
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
        waivers: {
          "worker/src/cron/sync-stablecoins/waived.ts": {
            disposition: "covered-by-enrolled-entrypoint",
            owner: "platform",
            createdAt: "2026-06-05",
            reviewAfter: "2026-09-05",
            reason: "covered elsewhere",
            nextAction: "add direct tests before enrollment",
            directEnrollmentCondition: "direct tests cover critical behavior",
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
            reviewAfter: "2026-09-05",
            reason: "covered elsewhere",
            nextAction: "add direct tests before enrollment",
            directEnrollmentCondition: "direct tests cover critical behavior",
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
            reviewAfter: "not-a-date",
            reason: "",
            nextAction: "",
            directEnrollmentCondition: "",
          },
          "worker/src/lib/old-review-helper.ts": {
            disposition: "covered-by-enrolled-entrypoint",
            owner: "platform",
            createdAt: "2026-06-05",
            reviewAfter: "2026-01-01",
            reason: "covered elsewhere",
            nextAction: "review helper",
            directEnrollmentCondition: "direct tests cover helper behavior",
          },
        },
        {
          candidateFiles: ["worker/src/lib/new-price-helper.ts", "worker/src/lib/old-review-helper.ts"],
          criticalFiles: [],
        },
      ),
    ).toEqual([
      'worker/src/lib/new-price-helper.ts: invalid waiver disposition "unknown"',
      "worker/src/lib/new-price-helper.ts: missing waiver reason",
      "worker/src/lib/new-price-helper.ts: missing waiver owner",
      "worker/src/lib/new-price-helper.ts: missing or invalid waiver createdAt",
      "worker/src/lib/new-price-helper.ts: missing or invalid waiver reviewAfter",
      "worker/src/lib/new-price-helper.ts: missing waiver nextAction",
      "worker/src/lib/new-price-helper.ts: missing waiver directEnrollmentCondition",
      "worker/src/lib/old-review-helper.ts: waiver reviewAfter must be on or after createdAt",
    ]);
  });

  it("collects and enforces critical waiver review queues", () => {
    const waivers = {
      "worker/src/lib/overdue-price-helper.ts": {
        disposition: "covered-by-enrolled-entrypoint",
        owner: "platform",
        createdAt: "2026-06-05",
        reviewAfter: "2026-06-10",
        reason: "covered elsewhere",
        nextAction: "review overdue helper",
        directEnrollmentCondition: "direct tests cover helper behavior",
      },
      "worker/src/lib/upcoming-price-helper.ts": {
        disposition: "covered-by-enrolled-entrypoint",
        owner: "platform",
        createdAt: "2026-06-05",
        reviewAfter: "2026-06-30",
        reason: "covered elsewhere",
        nextAction: "review upcoming helper",
        directEnrollmentCondition: "direct tests cover helper behavior",
      },
    };
    const candidateFiles = Object.keys(waivers);

    expect(
      collectCriticalCoverageWaiverReviewQueue(waivers, {
        candidateFiles,
        today: new Date("2026-06-20T00:00:00.000Z"),
        lookaheadDays: 14,
      }),
    ).toEqual({
      due: [
        {
          file: "worker/src/lib/overdue-price-helper.ts",
          owner: "platform",
          reviewAfter: "2026-06-10",
          nextAction: "review overdue helper",
          directEnrollmentCondition: "direct tests cover helper behavior",
        },
      ],
      upcoming: [
        {
          file: "worker/src/lib/upcoming-price-helper.ts",
          owner: "platform",
          reviewAfter: "2026-06-30",
          nextAction: "review upcoming helper",
          directEnrollmentCondition: "direct tests cover helper behavior",
        },
      ],
    });

    const errors: string[] = [];
    const exits: number[] = [];
    expect(
      runCriticalCoverageCompletenessGuard({
        candidateFiles,
        criticalFiles: [],
        waivers,
        reviewToday: new Date("2026-06-20T00:00:00.000Z"),
        consoleImpl: mockConsole({
          error: (message: string) => errors.push(message),
          log: () => {},
        }),
        exit: captureProcessExit((code) => {
          if (code !== undefined) exits.push(code);
        }),
      }),
    ).toBe(false);

    expect(exits).toEqual([1]);
    expect(errors).toContain("[coverage] Critical coverage waiver reviews are due or overdue:");
    expect(errors).toContain(
      "  worker/src/lib/overdue-price-helper.ts reviewAfter=2026-06-10 owner=platform nextAction=review overdue helper",
    );
  });

  it("fails the checker when a high-stakes candidate lacks enrollment or waiver", () => {
    const errors: string[] = [];
    const exits: number[] = [];

    expect(
      runCriticalCoverageCompletenessGuard({
        candidateFiles: ["worker/src/cron/sync-stablecoins/new-price-path.ts"],
        criticalFiles: [],
        waivers: {},
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
    expect(CRITICAL_COVERAGE_WAIVERS["worker/src/lib/depeg-resolver-incident-store.ts"]).toBeUndefined();
    expect(CRITICAL_COVERAGE_WAIVERS["worker/src/lib/depeg-resolver-publication-store.ts"]).toBeUndefined();
    expect(CRITICAL_FILES).toEqual(expect.arrayContaining([
      "worker/src/lib/depeg-resolver-incident-store.ts",
      "worker/src/lib/depeg-resolver-publication-store.ts",
      "worker/src/lib/publication-contract.ts",
      "functions/lib/upstream-proxy.ts",
      "shared/lib/peg-score.ts",
    ]));
    expect(CRITICAL_COVERAGE_WAIVERS).toEqual(expect.objectContaining({
      "worker/src/api/safety-score-history.ts": expect.objectContaining({ disposition: "deferred-ratchet" }),
      "worker/src/lib/psi-recompute.ts": expect.objectContaining({ disposition: "deferred-ratchet" }),
      "shared/lib/redemption-backstop-scoring.ts": expect.objectContaining({ disposition: "deferred-ratchet" }),
    }));
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
      env: testEnv({
        CRITICAL_COVERAGE_CHANGED_FILES: CRITICAL_FILES[0],
        CRITICAL_COVERAGE_RATCHET_ALL: "1",
      }),
      fsImpl: mockFsImpl({
        existsSync: (path: string) => files.has(path),
        readFileSync: (path: string) => {
          const value = files.get(path);
          if (value == null) throw new Error(`missing ${path}`);
          return value;
        },
      }),
      execFile: mockExecFileSync(() => ""),
      consoleImpl: mockConsole({
        log: (message: string) => logs.push(message),
        error: (message: string) => errors.push(message),
        warn: (message: string) => logs.push(message),
      }),
      exit: captureProcessExit((code) => {
        if (code !== undefined) exits.push(code);
      }),
    });

    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
    expect(logs).toContain("[coverage] Ratchet targets: all critical files (CRITICAL_COVERAGE_RATCHET_ALL=1)");
    expect(logs.filter((line) => line.includes("RATCHET PASS"))).toHaveLength(CRITICAL_FILES.length);
  });
});
