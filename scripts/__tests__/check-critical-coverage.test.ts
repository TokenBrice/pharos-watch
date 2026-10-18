import { describe, expect, it } from "vitest";
import {
  captureProcessExit,
  mockConsole,
  mockExecFileSync,
  mockFsImpl,
  testEnv,
} from "../test-utils/ci-script-test-helpers";

import {
  CRITICAL_COVERAGE_BRANCH_FLOORS,
  CRITICAL_COVERAGE_LINE_FLOORS,
  getChangedFilesFromGit,
  runCriticalCoverageCheck,
  runCriticalCoverageCompletenessCheck,
  runCriticalCoverageCompletenessGuard,
} from "../ci/check-critical-coverage.ts";
import {
  CRITICAL_FILES,
  collectCriticalCoverageCandidates,
  collectCriticalCoverageWaiverReviewQueue,
  parseLcov,
  validateCriticalCoverageWaiverMetadata,
  validateCriticalCoverageBaseline,
} from "../lib/critical-coverage.mjs";
import {
  REBASELINE_MEASUREMENT_COMMAND,
  validateCriticalCoverageRebaseline,
  type CriticalCoverageRebaselineRecord,
} from "../lib/critical-coverage-rebaseline.mts";
import { buildCriticalLcov, runCoverageFixture } from "./check-critical-coverage.test-support";


describe("critical coverage changed-file detection", () => {
  it.each([null, [], 42, { files: null }, { files: [] }].map((baseline) => ({ baseline })))("rejects a malformed baseline $baseline even with below-floor LCOV", ({ baseline }) => {
    const { exits, errors, logs } = runCoverageFixture({
      env: {},
      baseline,
      lcov: buildCriticalLcov({
        lineCoverage: { [CRITICAL_FILES[0]]: { lf: 100, lh: 0 } },
      }),
    });
    expect(exits).toEqual([1]);
    expect(errors).toContainEqual(expect.stringContaining("baseline"));
    expect(logs).not.toContain("[coverage] Critical coverage gate passed.");
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

  it("derives high-stakes pricing, depeg, reserve, score, publication, dews, and proxy candidates from source paths", () => {
    const candidates = collectCriticalCoverageCandidates({
      sourceFiles: [
        "functions/lib/upstream-proxy.ts",
        "functions/lib/csp-inject.ts",
        "shared/lib/peg-score.ts",
        "shared/lib/safety-score-version.ts",
        "shared/lib/classification/psi.ts",
        "worker/src/api/safety-score-history.ts",
        "worker/src/cron/sync-stablecoins/new-price-path.ts",
        "worker/src/cron/depeg-detection/new-decision-helper.ts",
        "worker/src/cron/sync-live-reserves-new-helper.ts",
        "worker/src/lib/mint-burn-scoring.ts",
        "worker/src/lib/live-reserves/store-extra.ts",
        "worker/src/lib/depeg-resolver-store-validators.ts",
        "worker/src/lib/dews/scoring.ts",
        "worker/src/lib/dews/service.ts",
        "worker/src/lib/dews/source-state/hydration.ts",
        "worker/src/lib/dews/types.ts",
        "worker/src/lib/dews/__tests__/scoring-blacklist.test.ts",
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
      "worker/src/lib/dews/scoring.ts",
      "worker/src/lib/dews/service.ts",
      "worker/src/lib/dews/source-state/hydration.ts",
      "worker/src/lib/live-reserves/store-extra.ts",
      "worker/src/lib/mint-burn-scoring.ts",
      "worker/src/lib/price-consensus.ts",
      "worker/src/lib/publication-contract.ts",
    ]);
  });


  it("treats an explicit zero-line lcov record as fully covered but still drops records without an LF line", () => {
    const parsed = parseLcov([
      "TN:",
      "SF:worker/src/lib/dews/contracts.ts",
      "FNF:0",
      "FNH:0",
      "LF:0",
      "LH:0",
      "BRF:0",
      "BRH:0",
      "end_of_record",
      "",
      "TN:",
      "SF:worker/src/lib/partial-record.ts",
      "end_of_record",
      "",
    ].join("\n"));

    expect(parsed.get("worker/src/lib/dews/contracts.ts")).toEqual({
      lf: 0,
      lh: 0,
      pct: 100,
      brf: 0,
      brh: 0,
      branchPct: null,
    });
    expect(parsed.has("worker/src/lib/partial-record.ts")).toBe(false);
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
  it("validates facade rationale and executable implementation ownership", () => {
    const file = "worker/src/lib/new-price-helper.ts";
    const owner = "worker/src/lib/price-consensus.ts";
    const ownerTest = "worker/src/lib/__tests__/price-consensus.test.ts";
    const waiver = { reviewAfter: "2026-09-05", reason: "Only forwards the covered implementation", owner, ownerTest };
    const options = {
      candidateFiles: [file, owner],
      criticalFiles: [owner],
      ownership: new Map([[owner, [ownerTest]]]),
    };

    expect(validateCriticalCoverageWaiverMetadata({ [file]: waiver }, options)).toEqual([]);
    expect(validateCriticalCoverageWaiverMetadata({ [owner]: waiver }, options)).toEqual([
      `${owner}: already enrolled in critical coverage; remove waiver`,
    ]);
    expect(validateCriticalCoverageWaiverMetadata({ [file]: { ...waiver, reviewAfter: "not-a-date" } }, options)).toEqual([
      `${file}: missing or invalid waiver reviewAfter`,
    ]);
    expect(validateCriticalCoverageWaiverMetadata({ [file]: { ...waiver, reason: " " } }, options)).toEqual([
      `${file}: missing coverage waiver reason`,
    ]);
    expect(validateCriticalCoverageWaiverMetadata({ [file]: { ...waiver, owner: file } }, options)).toEqual([
      `${file}: coverage waiver owner is not an enrolled implementation`,
    ]);
    expect(validateCriticalCoverageWaiverMetadata({ [file]: waiver }, { ...options, ownership: new Map() })).toEqual([
      `${file}: coverage waiver ownerTest does not import its implementation owner`,
    ]);
    expect(validateCriticalCoverageWaiverMetadata({ [file]: { ...waiver, ownerTest: "mock-only.test.ts" } }, options)).toEqual([
      `${file}: coverage waiver ownerTest does not import its implementation owner`,
    ]);
    expect(validateCriticalCoverageWaiverMetadata({ [file]: "2026-09-05" } as never, options)).toEqual([
      `${file}: missing or invalid waiver reviewAfter`,
      `${file}: missing coverage waiver reason`,
      `${file}: coverage waiver owner is not an enrolled implementation`,
    ]);
  });

  it("reports due facade reviews within grace and rejects expired reviews", () => {
    const owner = "worker/src/lib/price-consensus.ts";
    const ownerTest = "worker/src/lib/__tests__/price-consensus.test.ts";
    const facade = (reviewAfter: string) => ({
      reviewAfter, reason: "Forwards to the enrolled implementation", owner, ownerTest,
    });
    const waivers = {
      "worker/src/lib/overdue-price-helper.ts": facade("2026-06-10"),
      "worker/src/lib/upcoming-price-helper.ts": facade("2026-06-30"),
    };
    const candidateFiles = [...Object.keys(waivers), owner];

    expect(collectCriticalCoverageWaiverReviewQueue(waivers, {
      candidateFiles,
      today: new Date("2026-06-20T00:00:00.000Z"),
      lookaheadDays: 14,
    })).toEqual({
      due: [{ file: "worker/src/lib/overdue-price-helper.ts", reviewAfter: "2026-06-10" }],
      upcoming: [{ file: "worker/src/lib/upcoming-price-helper.ts", reviewAfter: "2026-06-30" }],
    });

    const run = (reviewToday: string) => {
      const logs: string[] = [];
      const errors: string[] = [];
      const exits: number[] = [];
      const passed = runCriticalCoverageCompletenessGuard({
        candidateFiles,
        criticalFiles: [owner],
        waivers,
        ownership: new Map([[owner, [ownerTest]]]),
        ownershipWaivers: {},
        reviewToday: new Date(reviewToday),
        consoleImpl: mockConsole({
          error: (message: string) => errors.push(message),
          log: (message: string) => logs.push(message),
        }),
        exit: captureProcessExit((code) => { if (code !== undefined) exits.push(code); }),
      });
      return { passed, logs, errors, exits };
    };
    const current = run("2026-06-20T00:00:00.000Z");
    expect(current.passed).toBe(true);
    expect(current.exits).toEqual([]);
    expect(current.errors).toEqual([]);
    expect(current.logs).toContain("[coverage] Critical coverage waiver reviews due or overdue:");
    expect(current.logs).toContain("  worker/src/lib/overdue-price-helper.ts reviewAfter=2026-06-10");
    expect(current.logs).toContain("[coverage] Critical coverage waiver reviews due soon:");

    const expired = run("2026-07-11T00:00:00.000Z");
    expect(expired.passed).toBe(false);
    expect(expired.exits).toEqual([1]);
    expect(expired.errors).toContain("[coverage] 1 critical-coverage waiver review(s) are more than 30 days overdue:");
  });

  it("runs ownership waivers through metadata validation and the ordinary review grace period", () => {
    const file = "worker/src/lib/new-price-helper.ts";
    const run = (ownershipWaiver: unknown, reviewToday: string) => {
      const logs: string[] = [];
      const errors: string[] = [];
      const exits: number[] = [];
      const passed = runCriticalCoverageCompletenessGuard({
        candidateFiles: [file],
        criticalFiles: [],
        waivers: {},
        ownership: new Map(),
        ownershipWaivers: { [file]: ownershipWaiver } as never,
        reviewToday: new Date(reviewToday),
        consoleImpl: mockConsole({
          error: (message: string) => errors.push(message),
          log: (message: string) => logs.push(message),
        }),
        exit: captureProcessExit((code) => {
          if (code !== undefined) exits.push(code);
        }),
      });
      return { passed, logs, errors, exits };
    };

    const legacy = run("permanent exemption", "2026-06-20T00:00:00.000Z");
    expect(legacy.passed).toBe(false);
    expect(legacy.exits).toEqual([1]);
    expect(legacy.errors).toContain(`  ${file}: missing or invalid ownership waiver reviewAfter`);
    expect(legacy.errors).toContain(`  ${file}: missing ownership waiver reason`);

    const expired = run(
      { reason: "reviewed ownership gap", reviewAfter: "2026-05-19" },
      "2026-06-20T00:00:00.000Z",
    );
    expect(expired.passed).toBe(false);
    expect(expired.exits).toEqual([1]);
    expect(expired.errors).toContain(
      "[coverage] 1 critical-coverage waiver review(s) are more than 30 days overdue:",
    );

    const current = run(
      { reason: "reviewed ownership gap", reviewAfter: "2026-06-10" },
      "2026-06-20T00:00:00.000Z",
    );
    expect(current.passed).toBe(true);
    expect(current.exits).toEqual([]);
    expect(current.errors).toEqual([]);
    expect(current.logs).toContain(`  ${file} reviewAfter=2026-06-10`);
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


  it("rejects missing, malformed, out-of-range, and unjustifiably lowered baseline entries", () => {
    const thresholds: Record<string, number> = {
      "worker/src/lib/auth.ts": 70,
      "worker/src/lib/price-consensus.ts": 40,
    };

    expect(validateCriticalCoverageBaseline(
      {
        "worker/src/lib/auth.ts": 69.9,
        "worker/src/lib/price-consensus.ts": "90",
      },
      ["worker/src/lib/auth.ts", "worker/src/lib/price-consensus.ts", "worker/src/lib/evm-rpc.ts"],
      (file) => thresholds[file] ?? 40,
    )).toEqual([
      "worker/src/lib/auth.ts: baseline 69.9% is below enforced floor 70.0%",
      "worker/src/lib/price-consensus.ts: baseline must be a finite number between 0 and 100",
      "worker/src/lib/evm-rpc.ts: baseline must be a finite number between 0 and 100",
    ]);

    expect(validateCriticalCoverageBaseline(
      { "worker/src/lib/auth.ts": 101 },
      ["worker/src/lib/auth.ts"],
      () => 70,
    )).toEqual([
      "worker/src/lib/auth.ts: baseline must be a finite number between 0 and 100",
    ]);
  });

  it("fails closed when the baseline file is absent", () => {
    const { logs, errors, exits } = runCoverageFixture({
      env: { CRITICAL_COVERAGE_CHANGED_FILES: CRITICAL_FILES[0] },
      lcov: buildCriticalLcov(),
    });

    expect(exits).toEqual([1]);
    expect(errors.some((line) => line.includes("Missing baseline file"))).toBe(true);
    expect(logs.some((line) => line.includes("Critical coverage gate passed"))).toBe(false);
  });

  it("ratchets all critical files when CRITICAL_COVERAGE_RATCHET_ALL is enabled", () => {
    const { logs, errors, exits } = runCoverageFixture({
      env: {
        CRITICAL_COVERAGE_CHANGED_FILES: CRITICAL_FILES[0],
        CRITICAL_COVERAGE_RATCHET_ALL: "1",
        PR_BASE_SHA: "base",
      },
      lcov: buildCriticalLcov(),
      baseline: { files: Object.fromEntries(CRITICAL_FILES.map((file) => [file, 100])) },
      execFile: mockExecFileSync(() => JSON.stringify({
        files: Object.fromEntries(CRITICAL_FILES.map((file) => [file, 100])),
      })),
    });

    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
    expect(logs).toContain("[coverage] Ratchet targets: all critical files (CRITICAL_COVERAGE_RATCHET_ALL=1)");
    expect(logs.filter((line) => line.includes("RATCHET PASS"))).toHaveLength(CRITICAL_FILES.length);
  });


  it.each(["source", "edited owner", "deleted owner"])("ratchets coverage regressions for a changed %s", (change) => {
    const file = "worker/src/lib/price-consensus.ts";
    const owner = change === "deleted owner" ? "worker/src/lib/__tests__/removed.test.ts" : "worker/src/lib/__tests__/price-consensus.test.ts";
    const { errors, exits } = runCoverageFixture({
      env: {
        CRITICAL_COVERAGE_CHANGED_FILES: change === "source" ? file : owner,
        PR_BASE_SHA: "base",
        ...(change === "deleted owner" ? { CRITICAL_COVERAGE_COMPARE_REF: "base" } : {}),
      },
      lcov: buildCriticalLcov({ lineCoverage: { [file]: { lf: 10, lh: 5 } } }),
      baseline: { files: { [file]: 51 } },
      execFile: mockExecFileSync((_cmd, args) => {
        if (args?.[0] === "show") return JSON.stringify({ files: { [file]: 51 } });
        if (args?.[0] === "ls-tree") return `${owner}\0${file}\0`;
        if (args?.[0] === "cat-file") return `deadbeef blob 28\0import "../price-consensus";\0`;
        throw new Error("Unexpected Git command");
      }),
    });

    expect(exits).toEqual([1]);
    expect(errors).toContain("[coverage] REGRESSION worker/src/lib/price-consensus.ts: 50.0% < baseline 51.0% (tolerance 0.0%)");
  });

  it.each([3, 4])("enforces the provider branch floor independently at %i/10 branches", (brh) => {
    const file = "worker/src/lib/evm-rpc.ts";
    const { errors, exits } = runCoverageFixture({
      env: { CRITICAL_COVERAGE_CHANGED_FILES: file, PR_BASE_SHA: "base" },
      lcov: buildCriticalLcov({ branchCoverage: { [file]: { brf: 10, brh } } }),
      baseline: { files: { [file]: 100 } },
      execFile: mockExecFileSync(() => JSON.stringify({ files: { [file]: 100 } })),
    });

    expect(exits).toEqual(brh < 4 ? [1] : []);
    expect(errors).toEqual(brh < 4 ? ["[coverage] BRANCH FAIL worker/src/lib/evm-rpc.ts: 30.0% (3/10) < 40.0%"] : []);
  });

  it("keeps the fixed reliability line floors", () => {
    expect(CRITICAL_COVERAGE_LINE_FLOORS).toEqual({
      "worker/src/lib/stablecoins-cache.ts": 50,
      "worker/src/lib/auth.ts": 70,
      "worker/src/lib/evm-rpc.ts": 70,
      "worker/src/lib/safety-scores.ts": 40,
      "worker/src/handlers/scheduled.ts": 40,
      "worker/src/cron/daily-digest.ts": 40,
      "worker/src/api/stablecoin-detail.ts": 30,
      "worker/src/api/health.ts": 60,
      "worker/src/api/status.ts": 40,
      "worker/src/cron/dex-liquidity/orchestrator.ts": 55,
      "worker/src/lib/api-pagination.ts": 70,
    });
  });

  it("enforces fixed line and branch floors despite retired per-file environment settings", () => {
    const file = "worker/src/lib/evm-rpc.ts";
    const { errors, exits } = runCoverageFixture({
      env: {
        CRITICAL_COVERAGE_CHANGED_FILES: file,
        PR_BASE_SHA: "base",
        CRITICAL_COVERAGE_THRESHOLD: "0",
        CRITICAL_COVERAGE_THRESHOLD_EVM_RPC: "0",
        CRITICAL_COVERAGE_BRANCH_THRESHOLD_EVM_RPC: "0",
      },
      lcov: buildCriticalLcov({
        lineCoverage: { [file]: { lf: 10, lh: 6 } },
        branchCoverage: { [file]: { brf: 10, brh: 3 } },
      }),
      baseline: { files: { [file]: 70 } },
      execFile: mockExecFileSync(() => JSON.stringify({ files: { [file]: 70 } })),
    });

    expect(exits).toEqual([1]);
    expect(errors).toContain("[coverage] FAIL worker/src/lib/evm-rpc.ts: 60.0% (6/10) < 70.0%");
    expect(errors).toContain("[coverage] BRANCH FAIL worker/src/lib/evm-rpc.ts: 30.0% (3/10) < 40.0%");
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

const rebaselineSource = "worker/src/lib/auth.ts";
const rebaselineBaseSha = "a".repeat(40);
const rebaselineRecordPath = ".ci/critical-coverage-rebaseline/T2-INTEGRATE.json";

function reviewedRebaseline(): CriticalCoverageRebaselineRecord {
  return {
    version: 1, waveId: "T2-INTEGRATE", baseSha: rebaselineBaseSha, candidateSha: "b".repeat(40),
    measurement: {
      command: REBASELINE_MEASUREMENT_COMMAND, baseLcovSha256: "c".repeat(64),
      candidateLcovSha256: "d".repeat(64), runUrl: null,
    },
    approvedBy: "owner", reviewer: "reviewer", approvedAt: "2026-10-16T00:00:00Z", transitionExpiresAt: "2099-01-01T00:00:00Z",
    entries: [{
      source: rebaselineSource, previousFloor: 90, measuredBefore: 90, measuredAfter: 80, newFloor: 80,
      configuredLineMinimum: 70, branchFloor: 40,
      removedTests: [{ path: "worker/src/lib/__tests__/auth.test.ts", titles: ["redundant input permutation"] }],
      survivingOwners: [{ path: "worker/src/lib/__tests__/auth.test.ts", title: "rejects unauthorized requests" }],
      protectedClass: "auth", rationale: "Remove redundant permutations while preserving the authorization boundary.",
    }],
  };
}

const rebaselineContext = {
  previous: { [rebaselineSource]: 90 },
  candidate: { [rebaselineSource]: 80 },
  lineMinimum: () => 70,
  branchMinimum: () => 40,
  now: new Date("2026-10-16T12:00:00Z"),
};

describe("reviewed critical coverage rebaseline", () => {
  it("accepts a valid record with exact decreased sources and unchanged absolute floors", () => {
    const record = reviewedRebaseline();
    expect(validateCriticalCoverageRebaseline(record, rebaselineContext)).toBe(record);
  });

  it.each([
    ["below minimum", (record: CriticalCoverageRebaselineRecord) => {
      record.entries[0].newFloor = record.entries[0].measuredAfter = 60;
    }, "below the configured line minimum"],
    ["without owner", (record: CriticalCoverageRebaselineRecord) => { record.entries[0].survivingOwners = []; }, "surviving owner"],
    ["expired", (record: CriticalCoverageRebaselineRecord) => { record.transitionExpiresAt = "2026-10-16T11:00:00Z"; }, "expired"],
    ["missing entry", (record: CriticalCoverageRebaselineRecord) => { record.entries = []; }, "exactly the set of decreased sources"],
    ["extra entry", (record: CriticalCoverageRebaselineRecord) => {
      record.entries.push({ ...record.entries[0], source: "worker/src/lib/evm-rpc.ts", previousFloor: 80 });
    }, "exactly the set of decreased sources"],
    ["unmeasured floor", (record: CriticalCoverageRebaselineRecord) => { record.entries[0].measuredAfter = 79; }, "equal measuredAfter"],
    ["changed branch floor", (record: CriticalCoverageRebaselineRecord) => { record.entries[0].branchFloor = 30; }, "branchFloor"],
  ] as const)("rejects a record %s", (_label, mutate, message) => {
    const record = reviewedRebaseline();
    mutate(record);
    const extra: Record<string, number> = message === "exactly the set of decreased sources"
      ? { "worker/src/lib/evm-rpc.ts": 80 } : {};
    const context = {
      ...rebaselineContext,
      previous: { ...rebaselineContext.previous, ...extra },
      candidate: { ...rebaselineContext.candidate, ...extra, [rebaselineSource]: record.entries[0]?.newFloor ?? 80 },
    };
    expect(() => validateCriticalCoverageRebaseline(record, context)).toThrow(message);
  });

  it("requires an owner even for a protected decrease smaller than 1.0pt", () => {
    const record = reviewedRebaseline();
    record.entries[0].newFloor = record.entries[0].measuredAfter = 89.5;
    record.entries[0].survivingOwners = [];
    expect(() => validateCriticalCoverageRebaseline(record, {
      ...rebaselineContext, candidate: { [rebaselineSource]: 89.5 },
    })).toThrow("surviving owner");
  });

  it.each(["present", "missing", "expired", "uncommitted"] as const)(
    "checks committed rebaseline evidence for a baseline decrease: %s",
    (evidence) => {
      const record = reviewedRebaseline();
      if (evidence === "expired") {
        record.approvedAt = "2020-01-01T00:00:00Z";
        record.transitionExpiresAt = "2021-01-01T00:00:00Z";
      }
      const { errors, exits, logs } = runCoverageFixture({
        env: { CRITICAL_COVERAGE_COMPARE_REF: "base", CRITICAL_COVERAGE_CHANGED_FILES: rebaselineSource },
        lcov: buildCriticalLcov({ lineCoverage: { [rebaselineSource]: { lf: 100, lh: 80 } } }),
        baseline: { files: { [rebaselineSource]: 80 } },
        execFile: mockExecFileSync((_cmd, args) => {
          if (args[0] === "show" && args[1] === "base:.ci/critical-coverage-baseline.json") {
            return JSON.stringify({ files: { [rebaselineSource]: 90 } });
          }
          if (args[0] === "rev-parse") return rebaselineBaseSha;
          if (args[0] === "ls-tree") return evidence === "missing" || evidence === "uncommitted" ? "" : `${rebaselineRecordPath}\0`;
          if (args[0] === "show" && args[1] === `HEAD:${rebaselineRecordPath}`) return JSON.stringify(record);
          throw new Error(`Unexpected git command: ${args.join(" ")}`);
        }),
      });
      if (evidence === "present") {
        expect(exits).toEqual([]);
        expect(errors).toEqual([]);
        expect(logs).toContain("[coverage] Critical coverage gate passed.");
      } else {
        expect(exits).toEqual([1]);
        expect(errors).toContainEqual(expect.stringContaining("matching committed rebaseline record"));
        expect(logs).not.toContain("[coverage] Critical coverage gate passed.");
      }
    },
  );
});

describe("nonprotected rebaseline owner boundary", () => {
  it.each([89, 89.5])("requires a surviving owner at the 1.0pt boundary: %s", (newFloor) => {
    const record = reviewedRebaseline();
    record.entries[0].protectedClass = "none";
    record.entries[0].survivingOwners = [];
    record.entries[0].newFloor = record.entries[0].measuredAfter = newFloor;
    const validate = () => validateCriticalCoverageRebaseline(record, {
      ...rebaselineContext, candidate: { [rebaselineSource]: newFloor },
    });
    if (newFloor === 89) expect(validate).toThrow("surviving owner");
    else expect(validate()).toBe(record);
  });
});

describe("critical coverage completeness baseline enforcement", () => {
  it.each([false, true])("checks committed decrease evidence without LCOV: record present=%s", (present) => {
    const record = reviewedRebaseline();
    const errors: string[] = [];
    const exits: number[] = [];
    const passed = runCriticalCoverageCompletenessCheck({
      env: testEnv({ PR_BASE_SHA: rebaselineBaseSha }),
      fsImpl: mockFsImpl({
        existsSync: (path) => path === ".ci/critical-coverage-baseline.json",
        readFileSync: () => JSON.stringify({ files: { [rebaselineSource]: 80 } }),
      }),
      execFile: mockExecFileSync((_cmd, args) => {
        if (args[0] === "show" && args[1] === `${rebaselineBaseSha}:.ci/critical-coverage-baseline.json`) {
          return JSON.stringify({ files: { [rebaselineSource]: 90 } });
        }
        if (args[0] === "rev-parse") return rebaselineBaseSha;
        if (args[0] === "ls-tree") return present ? `${rebaselineRecordPath}\0` : "";
        if (args[0] === "show" && args[1] === `HEAD:${rebaselineRecordPath}`) return JSON.stringify(record);
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      }),
      completenessOptions: { candidateFiles: [], criticalFiles: [], ownership: new Map(), waivers: {}, ownershipWaivers: {} },
      consoleImpl: mockConsole({ error: (message: string) => errors.push(message), log: () => {} }),
      exit: captureProcessExit((code) => { if (code !== undefined) exits.push(code); }),
    });
    expect(passed).toBe(present);
    expect(exits).toEqual(present ? [] : [1]);
    if (present) expect(errors).toEqual([]);
    else expect(errors).toContainEqual(expect.stringContaining("matching committed rebaseline record"));
  });

  it.each(["measured", "completeness"] as const)(
    "rejects an unrecorded hand-lowering with a missing, zero, or invalid base in %s execution",
    (mode) => {
      for (const ref of [undefined, "0".repeat(40), "missing-ref"]) {
        const logs: string[] = [];
        const errors: string[] = [];
        const exits: number[] = [];
        const options = {
          env: testEnv({
            CRITICAL_COVERAGE_CHANGED_FILES: rebaselineSource,
            ...(ref === undefined ? {} : { CRITICAL_COVERAGE_COMPARE_REF: ref }),
          }),
          fsImpl: mockFsImpl({
            existsSync: () => true,
            readFileSync: (path: string) => path === "coverage/lcov.info"
              ? buildCriticalLcov({ lineCoverage: { [rebaselineSource]: { lf: 100, lh: 80 } } })
              : JSON.stringify({ files: { [rebaselineSource]: 80 } }),
          }),
          execFile: mockExecFileSync(() => { throw new Error("unknown revision"); }),
          completenessOptions: { candidateFiles: [], criticalFiles: [], ownership: new Map(), waivers: {}, ownershipWaivers: {} },
          consoleImpl: mockConsole({
            log: (message: string) => logs.push(message),
            error: (message: string) => errors.push(message),
          }),
          exit: captureProcessExit((code) => { if (code !== undefined) exits.push(code); }),
        };
        if (mode === "completeness") expect(runCriticalCoverageCompletenessCheck(options)).toBe(false);
        else runCriticalCoverageCheck(options);
        expect(exits).toEqual([1]);
        expect(errors).toContainEqual(expect.stringContaining(ref === "missing-ref"
          ? "unknown revision" : "requires a nonzero comparison base"));
        expect(logs).not.toContainEqual(expect.stringContaining("skipped"));
        expect(logs).not.toContain("[coverage] Critical coverage gate passed.");
      }
    },
  );
});
