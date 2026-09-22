import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { parseTelegramDispatchCronMetadata } from "@shared/lib/status-metadata";
import type { StatusResponse } from "@shared/types/status";

vi.mock("../../stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(async () => ({ kind: "error", reason: "missing", updatedAt: null })),
  hasUsableStablecoinsPayload: vi.fn(() => false),
}));
vi.mock("../yield-health", () => ({ loadYieldHealthSummary: vi.fn(async () => null) }));
vi.mock("../../publication-contract", () => ({
  loadPublicationHealth: vi.fn(async () => ({ surfaces: {}, failedSurfaces: [] })),
}));
vi.mock("../../provider-circuit-health", () => ({ loadProviderCircuitHealth: vi.fn(async () => null) }));
vi.mock("../../canary-checks", () => ({ loadCanaryStatus: vi.fn(async () => null) }));
vi.mock("../derived-data", () => ({ getMintBurnReconciliation: vi.fn(async () => null) }));
vi.mock("../../live-reserves/store", () => ({ loadFreshIndependentLiveReserveMap: vi.fn(async () => new Map()) }));
vi.mock("../../collateral-drift", () => ({
  summarizeCollateralDriftFromLiveReserveMap: vi.fn(() => ({ driftCoins: [] })),
}));
vi.mock("../../telegram/pending-capacity", () => ({
  readTelegramPendingCapacity: vi.fn(async () => ({
    status: "available",
    value: {
      active: 0,
      due: 0,
      deferred: 0,
      expired: 0,
      nearTtl: 0,
      sending: 0,
      pendingSending: 0,
      freshSending: 0,
      executionUnknown: 0,
      pendingExecutionUnknown: 0,
      freshExecutionUnknown: 0,
      oldestExecutionUnknownAgeSec: null,
      executionUnknownSampleLimit: 5_001,
      executionUnknownLowerBound: false,
      sentCleanup: 0,
    },
  })),
  toPendingDeliveryBacklog: vi.fn(() => ({})),
}));
vi.mock("../price-source-depth", () => ({
  loadSourceDepthDistribution: vi.fn(async () => ({ "1": 1 })),
}));

import { loadStatusSupplements } from "../supplements";

const NOW = 1_779_000_000;

function statusDb(dispatchMetadata: Record<string, unknown> = {}) {
  return mockD1([
    { match: "FROM telegram_subscribers", rows: [], first: { n: 1 } },
    {
      match: "dispatch-telegram-alerts",
      rows: [],
      first: {
        started_at: NOW - 30,
        status: "ok",
        metadata: JSON.stringify(dispatchMetadata),
      },
    },
  ]);
}

function cronsWithPriceSourceHealth(priceSourceHealth: unknown): StatusResponse["crons"] {
  return {
    "sync-stablecoins": {
      lastRun: {
        status: "ok",
        metadata: { priceSourceHealth },
      },
    },
  } as unknown as StatusResponse["crons"];
}

describe("loadStatusSupplements", () => {
  it("preserves absent operational dispatch flags as null", () => {
    expect(parseTelegramDispatchCronMetadata({})).toMatchObject({
      cappedAtLimit: null,
      snapshotSeeded: null,
      eventlessFastPath: null,
      pendingRateLimited: null,
      safetyAlertsSuppressed: null,
      reserveAlertsSuppressed: null,
      presetFailure: null,
    });
  });

  it("publishes null suppression flags when dispatch metadata omits them", async () => {
    const supplements = await loadStatusSupplements(statusDb(), NOW, {});

    expect(supplements.telegramSummary).toMatchObject({
      safetyAlertsSuppressed: null,
      reserveAlertsSuppressed: null,
    });
  });

  it("isolates malformed price-source health metadata", async () => {
    const supplements = await loadStatusSupplements(
      statusDb(),
      NOW,
      cronsWithPriceSourceHealth({ totalAssets: "invalid" }),
    );

    expect(supplements.priceSourceHealth).toBeNull();
    expect(supplements.sectionErrors.priceSourceHealth).toEqual({
      code: "price_source_health_extraction_failed",
      message: "Price source health data unavailable.",
    });
  });

  it("adds source-depth distribution to valid price-source health metadata", async () => {
    const priceSourceHealth = {
      sourceDistribution: { coingecko: 1 },
      confidenceDistribution: { high: 1, "single-source": 0, low: 0, fallback: 0 },
      totalAssets: 1,
      lastSync: NOW - 60,
    };

    const supplements = await loadStatusSupplements(
      statusDb(),
      NOW,
      cronsWithPriceSourceHealth(priceSourceHealth),
    );

    expect(supplements.priceSourceHealth).toEqual({
      ...priceSourceHealth,
      sourceDepthDistribution: { "1": 1 },
    });
    expect(supplements.sectionErrors.priceSourceHealth).toBeUndefined();
  });
});
