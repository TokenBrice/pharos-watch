import { vi } from "vitest";
import type { MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import type { ActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";

export function mockDigestSafetyMapModule(
  actual: typeof import("../../lib/digest-safety-map"),
) {
  return {
    ...actual,
    resolveDigestSafetyMap: vi.fn(async (date: string) => ({
      kind: "available" as const,
      imageUrl: `https://pharos.watch/safety-scores/map.png?date=${date}`,
      manifest: {
        date,
        asOfSec: 1_772_796_000,
        renderedAtSec: 1_772_798_400,
        edition: "daily" as const,
        bytes: { png: 1_000_000 },
      },
    })),
  };
}

export function canonicalSafetySource(
  cards: unknown[],
): Extract<ActiveSafetyScoreSource, { kind: "v9" }> {
  const snapshot = makeWorkerReportCardsV9Response({
    cards: cards
      .map((value) => value as {
        id: string;
        overallGrade: ReturnType<typeof makeWorkerV9Card>["grade"];
        overallScore: number | null;
      })
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((card) =>
        makeWorkerV9Card({
          id: card.id,
          grade: card.overallGrade,
          score: card.overallScore,
        }),
      ),
  });
  return { kind: "v9", snapshot };
}

export interface TestDewsRow {
  stablecoin_id: string;
  score: number;
  band: string;
  signals_json: string;
  computed_at: number;
}

export function makePublishedDewsTables(dewsRows: TestDewsRow[]): MockTableConfig[] {
  const computedAt = dewsRows[0]!.computed_at;
  return [
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["dews:published-generation"],
      rows: [],
      first: {
        value: JSON.stringify({
          updatedAt: computedAt,
          source: "compute-dews",
          publishStatus: "published",
          coverageVersion: 2,
          expectedRowCount: dewsRows.length,
          stablecoinIdsDigest: buildDewsStablecoinIdsDigest(dewsRows.map((row) => row.stablecoin_id)),
        }),
        updated_at: computedAt,
      },
    },
    {
      match: "pharos:stress-signals:published-exact",
      rows: dewsRows.map((row) => ({ ...row })),
    },
  ];
}

export const PUBLISHED_GAUGE_SCORE = 37.5;

export function publishedGaugePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gauge: {
      score: PUBLISHED_GAUGE_SCORE,
      band: "HEALTHY",
      flightToQuality: false,
      flightIntensity: 0,
      classificationSource: "safety-score-v9-publication",
    },
    coins: [
      { stablecoinId: "usdt-tether", symbol: "USDT", flowIntensity: 100, pressureShiftScore: 100, netFlow24hUsd: 200_000_000 },
      { stablecoinId: "usdc-circle", symbol: "USDC", flowIntensity: -83.33, pressureShiftScore: -83.33, netFlow24hUsd: -50_000_000 },
      { stablecoinId: "paxg-paxos", symbol: "PAXG", flowIntensity: null, pressureShiftScore: null, netFlow24hUsd: -3_000_000 },
    ],
    chains: [
      { chainId: "ethereum", netFlow24hUsd: 150_000_000 },
      { chainId: "arbitrum", netFlow24hUsd: -3_000_000 },
    ],
    ...overrides,
  };
}

export function publishedGaugeTable(
  options: { value?: string; ageSec?: number } = {},
): MockTableConfig {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: ["mint-burn-flows:v3:aggregate:24"],
    rows: [],
    first: {
      value: options.value ?? JSON.stringify(publishedGaugePayload()),
      updated_at: nowSec - (options.ageSec ?? 300),
    },
  };
}
