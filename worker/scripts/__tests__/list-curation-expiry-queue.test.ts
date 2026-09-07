import { describe, expect, it } from "vitest";
import { eligibleReserveMeta } from "../../src/lib/__tests__/safety-score-v9-reserve-admission.test-support";
import type { StablecoinMeta } from "@shared/types/core";
import { buildCurationExpiryQueue, renderCurationExpiryQueue } from "../list-curation-expiry-queue";

// 2026-08-20T13:17:29Z, the clock of the incident capture this queue was built for.
const CLOCK_SEC = 1_787_231_849;
const DAY = 86_400;

function isoDaysAgo(days: number): string {
  return new Date((CLOCK_SEC - days * DAY) * 1_000).toISOString().slice(0, 10);
}

function isoDaysAfter(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY * 1_000).toISOString().slice(0, 10);
}

function auditedMeta(id: string, compositionAsOf: string): StablecoinMeta {
  const base = eligibleReserveMeta({
    id,
    mechanismArchetype: "fiat-cash",
    launchDate: "2020-01-01",
    mintAuthority: { ...eligibleReserveMeta().mintAuthority!, supervision: "attestation-only" },
    liveReservesConfig: {
      adapter: "curated-validated",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-solana" } },
    },
    reserveReview: {
      ...eligibleReserveMeta().reserveReview!,
      reviewedAt: compositionAsOf,
      compositionAsOf,
    },
    proofOfReserves: {
      ...eligibleReserveMeta().proofOfReserves!,
      latestReport: {
        ...eligibleReserveMeta().proofOfReserves!.latestReport!,
        periodEnd: compositionAsOf,
        publishedAt: isoDaysAfter(compositionAsOf, 1),
      },
    },
  });
  return base as unknown as StablecoinMeta;
}

function curatedMeta(id: string, compositionAsOf: string, reviewOverrides: Record<string, unknown> = {}): StablecoinMeta {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    flags: {},
    reserves: [
      {
        name: "USDC backing",
        pct: 100,
        risk: "low",
        coinId: "usdc-circle",
        depType: "collateral",
      },
    ],
    reserveReview: {
      reviewedAt: compositionAsOf,
      reviewer: "test",
      confidence: "verified",
      scope: "full-composition",
      knownUnknownExposurePct: 0,
      compositionAsOf,
      sources: [{ label: "test", url: "https://example.com/" }],
      ...reviewOverrides,
    },
  } as unknown as StablecoinMeta;
}

function replayFixture(options: {
  liveReserveMap?: Record<string, unknown>;
  liveToFallbackCoins?: string[];
  supplyById?: Record<string, number | null>;
} = {}) {
  return {
    pipeline: {
      fixedInput: {
        clockSec: CLOCK_SEC,
        liveReserveMap: options.liveReserveMap ?? {},
        liveToFallbackCoins: options.liveToFallbackCoins ?? [],
      },
      evaluatedSet: {
        assets: Object.entries(options.supplyById ?? {}).map(([assetId, circulatingUsd]) => ({
          assetId,
          stressState: { exitPortfolio: { circulatingUsd } },
        })),
      },
    },
  };
}

describe("buildCurationExpiryQueue", () => {
  it("lists only admitted compositions expiring within the lookahead, sorted by evaluated-set supply", () => {
    const metaById = new Map<string, StablecoinMeta>([
      // Admitted today, crosses the 31-day + 7-day grace bound within
      // the 10-day lookahead.
      ["small-expiring", curatedMeta("small-expiring", isoDaysAgo(30))],
      ["big-expiring", curatedMeta("big-expiring", isoDaysAgo(30))],
      ["unknown-supply-expiring", curatedMeta("unknown-supply-expiring", isoDaysAgo(30))],
      // Inadmissible today (non-zero known unknown): the worklist owns it.
      ["gap-inadmissible", curatedMeta("gap-inadmissible", isoDaysAgo(5), { knownUnknownExposurePct: 1.3 })],
      // Already past the 38-day effective bound: also worklist territory, not preventive.
      ["expired-out", curatedMeta("expired-out", isoDaysAgo(40))],
      // Fresh composition: admitted now and at the lookahead — excluded.
      ["fresh-ok", curatedMeta("fresh-ok", isoDaysAgo(2))],
      // Would expire, but a live snapshot published this cycle — excluded.
      ["live-covered", curatedMeta("live-covered", isoDaysAgo(25))],
    ]);

    const rows = buildCurationExpiryQueue(
      replayFixture({
        liveReserveMap: { "live-covered": [{ name: "live", pct: 100, risk: "low" }] },
        supplyById: {
          "big-expiring": 5_000_000,
          "small-expiring": 10_000,
          "unknown-supply-expiring": null,
        },
      }),
      10,
      metaById,
    );

    expect(rows.map((row) => [row.assetId, row.supplyUsd])).toEqual([
      ["big-expiring", 5_000_000],
      ["small-expiring", 10_000],
      ["unknown-supply-expiring", 0],
    ]);
    expect(rows.every((row) => row.hasCollateralLinks)).toBe(true);
    expect(rows.every((row) => row.adapterState === "none")).toBe(true);
  });

  it("keeps audited fallback admitted at the 38-day evidence transition, but lists loss of admission and excludes gated assets", () => {
    const auditedNearEvidenceBound = auditedMeta("audited-near-evidence-bound", isoDaysAgo(36));
    const auditedNearAdmissionBound = auditedMeta("audited-near-admission-bound", isoDaysAgo(360));
    const excludedFromFallback = auditedMeta("excluded-from-fallback", isoDaysAgo(360));
    const rows = buildCurationExpiryQueue(
      replayFixture({
        liveToFallbackCoins: ["audited-near-evidence-bound", "audited-near-admission-bound"],
        supplyById: {
          "audited-near-evidence-bound": 10,
          "audited-near-admission-bound": 20,
          "excluded-from-fallback": 30,
        },
      }),
      10,
      new Map([
        ["audited-near-evidence-bound", auditedNearEvidenceBound],
        ["audited-near-admission-bound", auditedNearAdmissionBound],
        ["excluded-from-fallback", excludedFromFallback],
      ]),
    );
    // The 38-day evidence transition changes strength/ceiling but does not
    // remove audited admission; the counterfactual report owns that signal.
    expect(rows.map((row) => row.assetId)).toEqual(["audited-near-admission-bound"]);
  });

  it("renders the documented column set and an explicit empty state", () => {
    const markdown = renderCurationExpiryQueue(
      buildCurationExpiryQueue(
        replayFixture({ supplyById: { solo: 1_234 } }),
        10,
        new Map([["solo", curatedMeta("solo", isoDaysAgo(29))]]),
      ),
      10,
    );
    expect(markdown).toContain(
      "| Asset | Supply (USD) | compositionAsOf | Age (d) | Dependency links | Adapter |",
    );
    expect(markdown).toContain("| solo | 1,234 |");

    expect(renderCurationExpiryQueue([], 10)).toContain(
      "No admitted curated composition expires within the lookahead window.",
    );
  });
});
