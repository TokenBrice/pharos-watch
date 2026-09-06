import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
import type {
  DdrrResponse,
  DdrrRow,
  DdrrV2CoverageRow,
  DdrrV2NoCallReviewRow,
  DdrrV2PredictionReviewRow,
} from "@shared/types/depeg-resolver-review";
import {
  DEFAULT_DDRR_CALIBRATION_REPORT_PATH,
  buildDdrrCalibrationReport,
  isTrustedDdrrApiKeyDestination,
  parseArgs,
  renderDdrrCalibrationReportMarkdown,
  runCli,
} from "../maintenance/generate-ddrr-calibration-report";

const STARTED_AT = 1_780_000_000;
const LOCKED_AT = STARTED_AT + 72 * 3600;

function horizonCell() {
  return {
    horizon: "24h" as const,
    state: "benchmarked" as const,
    probability: 0.6,
    probabilityDisplay: "60%",
    probabilityInterval: { lower: 0.5, upper: 0.7 },
    rawAtRisk: 20,
    uniqueCoins: 10,
    intervalClosures: 12,
    intervalNonClosures: 8,
  };
}

function horizonReview() {
  return {
    horizon: "24h" as const,
    horizonSec: 24 * 3600,
    result: "hit" as const,
    horizonElapsed: true,
    resolvedWithinHorizon: true,
    sourceCellState: "benchmarked" as const,
    probability: 0.6,
    probabilityDisplay: "60%",
    probabilityInterval: { lower: 0.5, upper: 0.7 },
  };
}

function baseRow(overrides: Partial<DdrrRow> = {}) {
  return {
    eventId: 1,
    currentEventId: 1,
    incidentKey: "ddr2:fixture",
    stablecoinId: "fixture-usd",
    symbol: "FXD",
    name: "Fixture USD",
    pegCurrency: "USD",
    governance: "centralized",
    direction: "below" as const,
    startedAt: STARTED_AT,
    eligibleAt: STARTED_AT + 72 * 3600,
    sourceEventState: "recovered" as const,
    terminalEvidenceAt: null,
    terminalEvidenceInterval: null,
    terminalEvidencePrecision: null,
    ...overrides,
  };
}

function prediction(overrides: Partial<DdrrV2PredictionReviewRow> = {}): DdrrV2PredictionReviewRow {
  return {
    ...baseRow(),
    kind: "prediction_review",
    publicPredictionId: 101,
    assessmentId: 201,
    predictionState: "frozen",
    predictionMethodologyVersion: "3.03",
    predictionPolicyVersion: "sticky-24h-v1",
    lockedAt: LOCKED_AT,
    publishedAt: LOCKED_AT,
    publicationSnapshotToken: "snapshot-fixture",
    frozen: {
      resolutionTier: "recovery_unlikely",
      predictedRemainingSec: 48 * 3600,
      iqrRemainingSec: [24 * 3600, 72 * 3600],
      horizonCells: [horizonCell()],
      stratum: "below · minor · fragile · USD",
      factors: [
        {
          code: "K2_backing_impairment",
          kind: "kill",
          severity: "severe",
          label: "Very-high-risk reserves paired with a severe below-peg break",
        },
        {
          code: "K5_exit_collapse",
          kind: "kill",
          severity: "elevated",
          label: "Thin exit liquidity",
        },
      ],
    },
    actual: {
      kind: "recovered",
      actualEndedAt: LOCKED_AT + 12 * 3600,
      actualRemainingSec: 12 * 3600,
      terminalEvidenceAt: null,
      terminalEvidenceInterval: null,
      terminalEvidencePrecision: null,
      reviewedAt: LOCKED_AT + 24 * 3600,
    },
    verdictReview: "false_terminal",
    durationReview: "faster_than_band",
    horizonReviews: [horizonReview()],
    predictedRemainingSec: 48 * 3600,
    actualRemainingSec: 12 * 3600,
    signedDurationErrorSec: -36 * 3600,
    absoluteDurationErrorSec: 36 * 3600,
    medianReview: "median_early_by",
    withinIqr: false,
    ...overrides,
  };
}

function noCall(overrides: Partial<DdrrV2NoCallReviewRow> = {}): DdrrV2NoCallReviewRow {
  return {
    ...baseRow({
      eventId: 2,
      currentEventId: 2,
      incidentKey: "ddr2:no-call",
      stablecoinId: "nocall-usd",
      symbol: "NOC",
      sourceEventState: "terminal",
      terminalEvidenceAt: LOCKED_AT + 10,
      terminalEvidenceInterval: { start: LOCKED_AT, end: LOCKED_AT + 86400 },
      terminalEvidencePrecision: "day",
    }),
    kind: "no_call_review",
    publicPredictionId: 102,
    assessmentId: 202,
    predictionState: "no_call",
    predictionMethodologyVersion: "3.03",
    predictionPolicyVersion: "sticky-24h-v1",
    lockedAt: LOCKED_AT,
    publishedAt: LOCKED_AT,
    publicationSnapshotToken: "snapshot-fixture",
    missingReasons: ["No reviewed mint authority"],
    actual: {
      kind: "terminal",
      actualEndedAt: null,
      actualRemainingSec: null,
      terminalEvidenceAt: LOCKED_AT + 10,
      terminalEvidenceInterval: { start: LOCKED_AT, end: LOCKED_AT + 86400 },
      terminalEvidencePrecision: "day",
      reviewedAt: LOCKED_AT + 24 * 3600,
    },
    verdictReview: "unscored_insufficient_signal",
    durationReview: "duration_unscored",
    horizonReviews: [],
    ...overrides,
  };
}

function coverage(overrides: Partial<DdrrV2CoverageRow> = {}): DdrrV2CoverageRow {
  return {
    ...baseRow({
      eventId: 3,
      currentEventId: 3,
      incidentKey: "ddr2:coverage|pipe",
      stablecoinId: "coverage-usd",
      symbol: "COV",
      sourceEventState: "terminal",
      terminalEvidenceAt: LOCKED_AT + 5,
      terminalEvidenceInterval: { start: LOCKED_AT, end: LOCKED_AT + 86400 },
      terminalEvidencePrecision: "day",
    }),
    kind: "coverage",
    predictionState: "missed_lock_terminal",
    actualOutcome: "terminal",
    actualEndedAt: null,
    terminalEvidenceSourceDate: "2026-06-29",
    coverageCause: "lock_missed",
    operationalCoverageCause: "lock_missed",
    outcomeQualityState: "classified",
    reason: "fixture",
    failedPublication: null,
    ...overrides,
  };
}

function response(rows: DdrrRow[]): DdrrResponse {
  return {
    _meta: {
      computedAt: LOCKED_AT + 24 * 3600,
      expiresAt: LOCKED_AT + 25 * 3600,
      degraded: false,
      degradedReason: null,
      reviewerVersion: "ddr-reviewer-v3",
      publicWarning: "fixture",
      assessedEventCount: rows.length,
      reviewedEventCount: rows.length,
      pendingEventCount: 0,
      durationScoredCount: rows.filter((row) => row.kind === "prediction_review" && row.signedDurationErrorSec != null)
        .length,
      verdictScoredCount: rows.filter((row) => row.kind === "prediction_review").length,
      assessmentRowLimit: 20_000,
      assessmentRowsTruncated: false,
      incidentRowLimit: 20_000,
      incidentRowsTruncated: false,
      publicRowLimit: 100,
      publicRowsTruncated: false,
      methodologyVersions: ["3.03"],
    },
    summary: summarizeDdrrRows(rows),
    rows,
    methodology: {
      version: "3.03",
      versionLabel: "v3.03",
      currentVersion: "3.03",
      currentVersionLabel: "v3.03",
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: LOCKED_AT,
      isCurrent: true,
    },
  };
}

describe("generate-ddrr-calibration-report", () => {
  it.each([
    {
      argv: [],
      expected: { inputPath: null, apiBase: null, url: null, prod: false, format: "markdown", reportPath: DEFAULT_DDRR_CALIBRATION_REPORT_PATH },
    },
    {
      argv: ["--input", "agents/ddrr.json", "--json", "--report", "agents/ddrr.json"],
      expected: { inputPath: "agents/ddrr.json", format: "json", reportPath: "agents/ddrr.json" },
    },
    {
      argv: ["--api-base", "https://api.example.test", "--stdout", "--limit", "12"],
      expected: { apiBase: "https://api.example.test", stdout: true, sampleLimit: 12 },
    },
    {
      argv: ["--url", "https://fixture.example.test/review", "--markdown", "--generated-at", "2026-08-29T00:00:00.000Z"],
      expected: { url: "https://fixture.example.test/review", format: "markdown", generatedAt: "2026-08-29T00:00:00.000Z" },
    },
    {
      argv: ["--prod", "--json", "--stdout"],
      expected: { prod: true, format: "json", stdout: true },
    },
  ])("accepts source/output option combination %#", ({ argv, expected }) => {
    expect(parseArgs(argv)).toMatchObject(expected);
  });

  it("rejects conflicting sources", () => {
    expect(() => parseArgs(["--input", "agents/ddrr.json", "--prod"])).toThrow(
      "Choose only one of --input, --api-base, --url, or --prod.",
    );
  });

  it("builds factor, no-call, coverage, and duration calibration summaries", () => {
    const report = buildDdrrCalibrationReport(response([prediction(), noCall(), coverage()]), {
      generatedAt: "2026-06-29T00:00:00.000Z",
      source: { mode: "input", detail: "fixture" },
    });

    expect(report.sample).toMatchObject({
      rowCount: 3,
      predictionReviewCount: 1,
      noCallReviewCount: 1,
      coverageCount: 1,
    });
    expect(report.durationCalibration.overall).toMatchObject({
      rowCount: 1,
      coinCount: 1,
      fasterThanBandCount: 1,
      bias: "too_slow",
      recommendation: "hold",
    });
    expect(report.noCallCalibration).toMatchObject({
      noCallCount: 1,
      maturedNoCallCount: 1,
      missingReasonCounts: { "No reviewed mint authority": 1 },
    });
    expect(report.coverageCalibration).toMatchObject({
      coverageRowCount: 1,
      operationalMissCount: 1,
      byPredictionState: { missed_lock_terminal: 1 },
    });
    expect(report.reserveDependencyNuance.factorRows[0]).toMatchObject({
      factorCode: "K2_backing_impairment",
      verdictCounts: expect.objectContaining({ false_terminal: 1 }),
      recommendation: "monitor",
    });
    expect(report.k5ExitCollapse.factorRows[0]).toMatchObject({
      factorCode: "K5_exit_collapse",
      recommendation: "monitor",
    });
  });

  it("renders markdown sections and escapes table cells", () => {
    const report = buildDdrrCalibrationReport(
      response([
        prediction({
          incidentKey: "ddr2:k2|pipe",
        }),
        noCall(),
        coverage(),
      ]),
      {
        generatedAt: "2026-06-29T00:00:00.000Z",
        source: { mode: "input", detail: "fixture" },
      },
    );

    const markdown = renderDdrrCalibrationReportMarkdown(report);
    expect(markdown).toContain("# DDRR Calibration Report");
    expect(markdown).toContain("## Factor Attribution");
    expect(markdown).toContain("## Stage 2 Duration Calibration");
    expect(markdown).toContain("## K5 Exit-Collapse Calibration");
    expect(markdown).toContain("## Reserve Dependency Nuance");
    expect(markdown).toContain("## Mint-Incident Timing Robustness");
    expect(markdown).toContain("ddr2:k2\\|pipe");
  });

  it("loads saved payloads and writes JSON output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ddrr-calibration-"));
    const input = join(dir, "ddrr.json");
    const generatedAt = "2026-06-29T00:00:00.000Z";
    writeFileSync(input, JSON.stringify(response([prediction()])), "utf8");

    await expect(runCli(["--input", input, "--json", "--generated-at", generatedAt], dir)).resolves.toBe(0);
    const output = join(dir, DEFAULT_DDRR_CALIBRATION_REPORT_PATH);
    const expected = buildDdrrCalibrationReport(response([prediction()]), {
      generatedAt,
      source: { mode: "input", detail: input },
    });
    expect(readFileSync(output, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it("fetches production site-data with site headers", async () => {
    const payload = response([prediction()]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ payload }), { status: 200 }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runCli(
          ["--prod", "--json", "--stdout", "--generated-at", "2026-06-29T00:00:00.000Z"],
          process.cwd(),
          fetchMock as unknown as typeof fetch,
        ),
      ).resolves.toBe(0);
    } finally {
      stdout.mockRestore();
    }
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pharos.watch/_site-data/depeg-resolver-review",
      expect.objectContaining({
        headers: expect.objectContaining({
          Origin: "https://pharos.watch",
          Referer: "https://pharos.watch/depeg/",
        }),
      }),
    );
  });

  it("only sends environment API keys to trusted api-base origins", async () => {
    expect(isTrustedDdrrApiKeyDestination("https://api.pharos.watch")).toBe(true);
    expect(isTrustedDdrrApiKeyDestination("http://127.0.0.1:8787")).toBe(true);
    expect(isTrustedDdrrApiKeyDestination("https://api.example.test")).toBe(false);

    const originalPharosApiKey = process.env.PHAROS_API_KEY;
    const payload = response([prediction()]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ payload }), { status: 200 }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      process.env.PHAROS_API_KEY = "ddrr-fixture-value";
      await expect(
        runCli(
          [
            "--api-base",
            "https://api.example.test",
            "--json",
            "--stdout",
            "--generated-at",
            "2026-06-29T00:00:00.000Z",
          ],
          process.cwd(),
          fetchMock as unknown as typeof fetch,
        ),
      ).resolves.toBe(0);
    } finally {
      if (originalPharosApiKey === undefined) {
        delete process.env.PHAROS_API_KEY;
      } else {
        process.env.PHAROS_API_KEY = originalPharosApiKey;
      }
      stdout.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/depeg-resolver-review",
      expect.objectContaining({
        headers: expect.not.objectContaining({ "X-API-Key": "ddrr-fixture-value" }),
      }),
    );
  });
});
