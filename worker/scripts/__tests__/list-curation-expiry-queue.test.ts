import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import {
  buildCurationExpiryQueue,
  renderCurationExpiryQueue,
} from "../list-curation-expiry-queue";

// 2026-08-20T13:17:29Z, the clock of the incident capture this queue was built for.
const CLOCK_SEC = 1_787_231_849;
const DAY = 86_400;

function isoDaysAgo(days: number): string {
  return new Date((CLOCK_SEC - days * DAY) * 1_000).toISOString().slice(0, 10);
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
  supplyById?: Record<string, number>;
} = {}) {
  return {
    pipeline: {
      fixedInput: {
        clockSec: CLOCK_SEC,
        liveReserveMap: options.liveReserveMap ?? {},
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
      // Admitted today, crosses the 31-day bound within the 10-day lookahead.
      ["small-expiring", curatedMeta("small-expiring", isoDaysAgo(25))],
      ["big-expiring", curatedMeta("big-expiring", isoDaysAgo(25))],
      // Inadmissible today (non-zero known unknown): the worklist owns it.
      ["gap-inadmissible", curatedMeta("gap-inadmissible", isoDaysAgo(5), { knownUnknownExposurePct: 1.3 })],
      // Already past the 31-day bound: also worklist territory, not preventive.
      ["expired-out", curatedMeta("expired-out", isoDaysAgo(40))],
      // Fresh composition: admitted now and at the lookahead — excluded.
      ["fresh-ok", curatedMeta("fresh-ok", isoDaysAgo(2))],
      // Would expire, but a live snapshot published this cycle — excluded.
      ["live-covered", curatedMeta("live-covered", isoDaysAgo(25))],
    ]);

    const rows = buildCurationExpiryQueue(
      replayFixture({
        liveReserveMap: { "live-covered": { slices: [] } },
        supplyById: { "big-expiring": 5_000_000, "small-expiring": 10_000 },
      }),
      10,
      metaById,
    );

    expect(rows.map((row) => [row.assetId, row.supplyUsd])).toEqual([
      ["big-expiring", 5_000_000],
      ["small-expiring", 10_000],
    ]);
    expect(rows.every((row) => row.hasCollateralLinks)).toBe(true);
    expect(rows.every((row) => row.adapterState === "none")).toBe(true);
  });

  it("renders the documented column set and an explicit empty state", () => {
    const markdown = renderCurationExpiryQueue(
      buildCurationExpiryQueue(
        replayFixture({ supplyById: { solo: 1_234 } }),
        10,
        new Map([["solo", curatedMeta("solo", isoDaysAgo(28))]]),
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
