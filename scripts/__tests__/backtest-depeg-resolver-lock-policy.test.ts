import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DDR_LOCK_BACKSTOP_DELAY_SEC,
  DDR_LOCK_READINESS_THRESHOLD,
  buildDdrLockPolicyBacktest,
  builtinAcceptanceRows,
  evaluateDdrLockPolicy,
  parseArgs,
  runCli,
  type DdrLockPolicyBacktestRow,
} from "../maintenance/backtest-depeg-resolver-lock-policy";

const STARTED_AT = 1_800_000_000;

function row(overrides: Partial<Parameters<typeof evaluateDdrLockPolicy>[0]> = {}) {
  return {
    incidentKey: "ddr2:test",
    eventId: 1,
    startedAt: STARTED_AT,
    evaluatedAt: STARTED_AT + 12 * 3600,
    readinessScore: 0.5,
    outcomeKind: "prediction" as const,
    ...overrides,
  };
}

describe("backtest-depeg-resolver-lock-policy", () => {
  it.each([
    {
      argv: [],
      expected: { fixturePath: null, reportPath: null, format: "markdown", generatedAt: null },
    },
    {
      argv: ["--fixture", "rows.json", "--json", "--report", "out/report.json", "--generated-at", "2026-08-29T00:00:00.000Z"],
      expected: { fixturePath: "rows.json", reportPath: "out/report.json", format: "json", generatedAt: "2026-08-29T00:00:00.000Z" },
    },
    {
      argv: ["--fixture", "rows.json", "--generated-at", "now"],
      expected: { fixturePath: "rows.json", generatedAt: "now" },
    },
  ])("accepts fixture/output option combination %#", ({ argv, expected }) => {
    expect(parseArgs(argv)).toMatchObject(expected);
  });

  it("preserves the legacy strict flag set and optional missing values", () => {
    expect(parseArgs(["--fixture"])).toMatchObject({ fixturePath: null });
    expect(parseArgs(["--report"])).toMatchObject({ reportPath: null });
    expect(() => parseArgs(["--markdown"])).toThrow("Unknown argument: --markdown");
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("early-locks only when readiness score is strictly greater than 0.75", () => {
    const above = evaluateDdrLockPolicy(row({ readinessScore: DDR_LOCK_READINESS_THRESHOLD + 0.000001 }));
    const exact = evaluateDdrLockPolicy(row({ eventId: 2, readinessScore: DDR_LOCK_READINESS_THRESHOLD }));

    expect(above).toMatchObject({
      action: "lock_prediction",
      eligibilityReason: "readiness_early_lock",
      shouldSeal: true,
      eligibleAt: STARTED_AT + 12 * 3600,
      readiness: {
        threshold: DDR_LOCK_READINESS_THRESHOLD,
        earlyLockSatisfied: true,
      },
    });
    expect(exact).toMatchObject({
      action: "pending_lock",
      eligibilityReason: "readiness_not_met",
      shouldSeal: false,
      eligibleAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
      readiness: {
        threshold: DDR_LOCK_READINESS_THRESHOLD,
        earlyLockSatisfied: false,
      },
    });
  });

  it("keeps below-threshold incidents pending until the 72h backstop", () => {
    const beforeBackstop = evaluateDdrLockPolicy(
      row({
        readinessScore: 0.74,
        evaluatedAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC - 1,
      }),
    );
    const atBackstop = evaluateDdrLockPolicy(
      row({
        eventId: 2,
        readinessScore: 0.74,
        evaluatedAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
      }),
    );

    expect(beforeBackstop).toMatchObject({
      action: "pending_lock",
      eligibilityReason: "readiness_not_met",
      shouldSeal: false,
    });
    expect(atBackstop).toMatchObject({
      action: "lock_prediction",
      eligibilityReason: "backstop_72h",
      shouldSeal: true,
      eligibleAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
    });
  });

  it("uses the 72h backstop for predictions and no-calls", () => {
    const prediction = evaluateDdrLockPolicy(
      row({
        evaluatedAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
        readinessScore: null,
        outcomeKind: "prediction",
      }),
    );
    const noCall = evaluateDdrLockPolicy(
      row({
        eventId: 2,
        evaluatedAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
        readinessScore: null,
        outcomeKind: "no_call",
      }),
    );

    expect(prediction).toMatchObject({
      action: "lock_prediction",
      eligibilityReason: "backstop_72h",
      outcomeKind: "prediction",
    });
    expect(noCall).toMatchObject({
      action: "lock_no_call",
      eligibilityReason: "backstop_72h",
      outcomeKind: "no_call",
    });
  });

  it("attributes locks at or after 72h to the backstop even when readiness is high", () => {
    const decision = evaluateDdrLockPolicy(
      row({
        readinessScore: DDR_LOCK_READINESS_THRESHOLD + 0.01,
        evaluatedAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
      }),
    );

    expect(decision).toMatchObject({
      action: "lock_prediction",
      eligibilityReason: "backstop_72h",
      shouldSeal: true,
      eligibleAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
      readiness: {
        earlyLockSatisfied: true,
        backstopAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
      },
    });
  });

  it("defers eligible locks when health is degraded", () => {
    const decision = evaluateDdrLockPolicy(
      row({
        readinessScore: 0.99,
        healthStatus: "degraded",
      }),
    );

    expect(decision).toMatchObject({
      action: "lock_deferred",
      eligibilityReason: "readiness_early_lock",
      shouldSeal: false,
      outcomeKind: null,
    });
  });

  it("keeps old public-policy visibility from producing a duplicate seal", () => {
    const decision = evaluateDdrLockPolicy(
      row({
        existingPublicPredictionId: 77,
        readinessScore: 0.99,
        evaluatedAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
      }),
    );

    expect(decision).toMatchObject({
      action: "already_sealed",
      eligibilityReason: "existing_public_prediction",
      shouldSeal: false,
      existingPublicPredictionId: 77,
    });
  });

  it("emits stable readiness metadata and decision hashes", () => {
    const input = row({ readinessScore: 0.99 });
    const first = evaluateDdrLockPolicy(input);
    const second = evaluateDdrLockPolicy({ ...input });

    expect(first.decisionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.decisionHash).toBe(second.decisionHash);
    expect(first.readiness).toEqual({
      score: 0.99,
      threshold: DDR_LOCK_READINESS_THRESHOLD,
      earlyLockSatisfied: true,
      backstopAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
      evaluatedAt: STARTED_AT + 12 * 3600,
    });
  });

  it("passes the built-in acceptance matrix", () => {
    const result = buildDdrLockPolicyBacktest({
      rows: builtinAcceptanceRows(),
      generatedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(result.summary).toMatchObject({
      total: 7,
      passed: 7,
      failed: 0,
      earlyLockCount: 2,
      backstopPredictionCount: 1,
      backstopNoCallCount: 1,
      pendingCount: 2,
      deferredCount: 1,
      alreadySealedCount: 1,
    });
  });

  it("can run against an external fixture", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ddr-lock-policy-"));
    const generatedAt = "2026-06-04T00:00:00.000Z";
    const fixtureRows: DdrLockPolicyBacktestRow[] = [{
      incidentKey: "ddr2:fixture",
      eventId: 10,
      startedAt: STARTED_AT,
      evaluatedAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
      readinessScore: 0.4,
      healthStatus: "healthy",
      outcomeKind: "no_call",
      existingPublicPredictionId: null,
      expectedAction: "lock_no_call",
    }];
    writeFileSync(
      join(tmp, "fixture.json"),
      JSON.stringify(fixtureRows),
    );
    const expected = buildDdrLockPolicyBacktest({ rows: fixtureRows, generatedAt });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let output = "";
    try {
      await expect(
        runCli(["--fixture", "fixture.json", "--json", "--generated-at", generatedAt], tmp),
      ).resolves.toBe(0);
      output = String(stdout.mock.calls[0]?.[0] ?? "");
    } finally {
      stdout.mockRestore();
    }

    expect(output).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });
});
