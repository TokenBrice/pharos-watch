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

function curatedMeta(id: string, overrides: Record<string, unknown> = {}): StablecoinMeta {
  const compositionAsOf = (overrides.compositionAsOf as string | undefined) ?? isoDaysAgo(25);
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
      ...(overrides.reserveReview as Record<string, unknown> | undefined),
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "reserveReview" && key !== "compositionAsOf"),
    ),
  } as unknown as StablecoinMeta;
}

function capture(overrides: Record<string, unknown> = {}) {
  return {
    clockSec: CLOCK_SEC,
    liveReserveMap: {},
    liveToFallbackCoins: [],
    aggregateCirculatingById: {},
    ...overrides,
  };
}

describe("buildCurationExpiryQueue", () => {
  it("classifies expiring vs inadmissible, skips fresh and live-snapshot assets, and sorts by supply", () => {
    const metaById = new Map<string, StablecoinMeta>([
      // Admitted today, crosses the 31-day bound within the 10-day lookahead.
      ["small-expiring", curatedMeta("small-expiring", { compositionAsOf: isoDaysAgo(25) })],
      ["big-expiring", curatedMeta("big-expiring", { compositionAsOf: isoDaysAgo(25) })],
      // Fails admission today (non-zero known unknown), independent of age.
      [
        "gap-inadmissible",
        curatedMeta("gap-inadmissible", {
          compositionAsOf: isoDaysAgo(5),
          reserveReview: { knownUnknownExposurePct: 1.3 },
        }),
      ],
      // Fresh composition: admitted now and at the lookahead — excluded.
      ["fresh-ok", curatedMeta("fresh-ok", { compositionAsOf: isoDaysAgo(2) })],
      // Expired but a live snapshot published this cycle — excluded.
      ["live-covered", curatedMeta("live-covered", { compositionAsOf: isoDaysAgo(40) })],
    ]);

    const rows = buildCurationExpiryQueue(
      capture({
        liveReserveMap: { "live-covered": { slices: [] } },
        aggregateCirculatingById: {
          "big-expiring": { circulating: { peggedUSD: 5_000_000 } },
          "small-expiring": { circulating: { peggedUSD: 10_000 } },
        },
      }),
      10,
      metaById,
    );

    expect(rows.map((row) => [row.assetId, row.status, row.supplyUsd])).toEqual([
      ["gap-inadmissible", "inadmissible", 0],
      ["big-expiring", "expiring", 5_000_000],
      ["small-expiring", "expiring", 10_000],
    ]);
    expect(rows.every((row) => row.hasCollateralLinks)).toBe(true);
    expect(rows.every((row) => row.adapterState === "none")).toBe(true);
  });

  it("renders the documented column set and an explicit empty state", () => {
    const markdown = renderCurationExpiryQueue(
      buildCurationExpiryQueue(
        capture({ aggregateCirculatingById: { solo: { circulating: { peggedUSD: 1_234 } } } }),
        10,
        new Map([["solo", curatedMeta("solo", { compositionAsOf: isoDaysAgo(28) })]]),
      ),
      10,
    );
    expect(markdown).toContain(
      "| Asset | Status | Supply (USD) | compositionAsOf | Age (d) | Dependency links | Adapter |",
    );
    expect(markdown).toContain("| solo | expiring | 1,234 |");

    expect(renderCurationExpiryQueue([], 10)).toContain(
      "No curated composition is inadmissible or expiring within the lookahead window.",
    );
  });
});
