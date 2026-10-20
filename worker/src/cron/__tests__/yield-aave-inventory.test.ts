import { afterEach, describe, expect, it, vi } from "vitest";
import { AAVE_V3_PINNED_RESERVES } from "../yield-sync/family-registry";
import type { AaveV3RateTarget } from "../yield-sync/sources-rpc";

vi.mock("../yield-sync/family-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../yield-sync/family-registry")>();
  return {
    ...actual,
    COMPOUND_V3_COMETS: [],
  };
});

vi.mock("../yield-sync/sources-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../yield-sync/sources-rpc")>();

  // Vitest hoists this factory before static fixture imports initialize.
  const { emptyRpcTelemetry } = await import("./sync-yield-supplemental.test-support");
  return {
    ...actual,
    createOptionalRpcFamilyTelemetry: (targetCount: number) => ({ ...emptyRpcTelemetry(), targetCount }),
    fetchCompoundV3SupplyRates: async () => ({ results: [], telemetry: emptyRpcTelemetry() }),
    fetchAaveV3SupplyRates: async (targets: AaveV3RateTarget[]) => ({
      results: targets.map((target) => ({ ...target, apy: 4, sourceTvlUsd: 100_000_000 })),
      telemetry: { ...emptyRpcTelemetry(), targetCount: targets.length, attemptedCount: targets.length,
        resolvedTargetCount: targets.length, emittedCount: targets.length },
    }),
  };
});

vi.mock("../yield-sync/sources-optional", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../yield-sync/sources-optional")>();

  // Vitest hoists this factory before static fixture imports initialize.
  const { healthyFamilyFetch } = await import("./sync-yield-supplemental.test-support");
  return {
    ...actual,
    fetchMorphoVaultSources: async () => healthyFamilyFetch(),
    fetchPendleMarketSources: async () => healthyFamilyFetch(),
    fetchRoycoDawnSources: async () => ({ candidates: [], degraded: false }),
    fetchYearnKongSources: async () => healthyFamilyFetch(),
    fetchBeefySources: async () => healthyFamilyFetch(),
  };
});
vi.mock("../../lib/db-cache", () => ({
  getCaches: vi.fn(async () => new Map()),
  setCache: vi.fn(async () => undefined),
  setCacheIfNewer: vi.fn(async () => ({ written: true, skippedBecauseNewer: false })),
}));

import { setCacheIfNewer } from "../../lib/db-cache";
import { syncYieldSupplemental } from "../sync-yield-supplemental";
import type { ResolvedYieldCandidate } from "../yield-sync/types";

describe("Aave pinned inventory snapshots", () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it("refreshes verified majors every run while replacing rotating windows without renewing old observations", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-27T12:25:00Z") / 1000;
    const snapshots: ResolvedYieldCandidate[][] = [];
    for (const time of [now, now + 4 * 3600]) {
      vi.setSystemTime(time * 1000);
      await syncYieldSupplemental({} as D1Database, undefined, new Map());
      const calls = vi.mocked(setCacheIfNewer).mock.calls.filter((call) => call[1] === "yield:supplemental-sources:v1:aaveV3");
      const snapshot = JSON.parse(String(calls[calls.length - 1]?.[2])) as { data: ResolvedYieldCandidate[] };
      snapshots.push(snapshot.data);
      expect(snapshot.data).toHaveLength(6);
      for (const pin of AAVE_V3_PINNED_RESERVES) {
        expect(snapshot.data.find((row) => row.stablecoinId === pin.stablecoinId && row.chain === pin.chain)?.yield)
          .toMatchObject({ sourceKey: `aave-v3-onchain:${pin.chain}:${pin.assetAddress}`, sourceObservedAt: time });
      }
    }
    const [first, second] = snapshots;
    const secondKeys = new Set(second!.map((row) => row.yield.sourceKey));
    const departed = first!.filter((row) => !secondKeys.has(row.yield.sourceKey));
    expect(departed).toHaveLength(3);
    expect(departed.every((row) => row.yield.sourceObservedAt === now)).toBe(true);
    expect(second!.every((row) => row.yield.sourceObservedAt === now + 4 * 3600)).toBe(true);
  });
});
