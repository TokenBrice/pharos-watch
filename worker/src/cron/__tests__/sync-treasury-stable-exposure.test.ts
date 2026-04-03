import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { sleepWithSignal } from "../../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { setCacheIfNewer, shouldSkipFreshCache } from "../../lib/db-cache";
import { buildReportCardsSnapshot } from "../../lib/report-cards-snapshot";
import { fetchSimWalletBalances, fetchSimWalletDefiStableBalances } from "../../lib/sim-balances";
import { SIM_BALANCES_OWNER_GROUP_DELAY_MS } from "../../lib/constants";

vi.mock("@shared/lib/treasury-seeds", () => ({
  TREASURY_SEEDS: [],
  TREASURY_LAUNCH_SEEDS: [
    {
      protocolId: "maker",
      name: "Sky / Maker",
      owners: [
        { chain: "ethereum", address: "0x1111111111111111111111111111111111111111" },
        { chain: "base", address: "0x2222222222222222222222222222222222222222" },
      ],
    },
  ],
}));

vi.mock("@shared/lib/treasury-stable-exposure", () => ({
  computeTreasuryStableExposureEntity: vi.fn((seed: { protocolId: string; name: string }, walletSnapshots: unknown[]) => ({
    protocolId: seed.protocolId,
    name: seed.name,
    decentralizedStableUsd: walletSnapshots.length,
    decentralizedStablePctOfTreasury: 0,
  })),
  buildTreasuryStableExposureSnapshot: vi.fn((_allSeeds: unknown[], entities: unknown[], updatedAt: number) => ({
    entities,
    updatedAt,
    coverage: {
      launchOwnerChainTuples: 2,
    },
  })),
}));

vi.mock("../../lib/report-cards-snapshot", () => ({
  buildReportCardsSnapshot: vi.fn(async () => ({ cards: [] })),
}));

vi.mock("../../lib/db-cache", () => ({
  shouldSkipFreshCache: vi.fn(async () => false),
  setCacheIfNewer: vi.fn(async () => undefined),
}));

vi.mock("../../lib/circuit-breaker", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/circuit-breaker")>();
  return {
    ...original,
    shouldAttemptFetch: vi.fn(async () => true),
    recordOutcomeSafe: vi.fn(async () => undefined),
  };
});

vi.mock("../../lib/sim-balances", () => ({
  fetchSimWalletBalances: vi.fn(async () => ({
    balances: [],
    warnings: [],
  })),
  fetchSimWalletDefiStableBalances: vi.fn(async () => ({
    balances: [],
    warnings: [],
  })),
}));

vi.mock("../../lib/abort", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/abort")>();
  return {
    ...original,
    sleepWithSignal: vi.fn(async () => undefined),
  };
});

import { syncTreasuryStableExposure } from "../sync-treasury-stable-exposure";

describe("syncTreasuryStableExposure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T08:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("paces Sim owner-group fetches and skips the trailing delay", async () => {
    const db = mockD1();

    const result = await syncTreasuryStableExposure(db, "sim-key");

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(1);
    expect(shouldSkipFreshCache).toHaveBeenCalledWith(db, "treasury-stable-exposure", 20 * 60 * 60);
    expect(shouldAttemptFetch).toHaveBeenCalledWith(db, "sim-balances");
    expect(buildReportCardsSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchSimWalletBalances).toHaveBeenCalledTimes(4);
    expect(fetchSimWalletDefiStableBalances).toHaveBeenCalledTimes(2);
    expect(sleepWithSignal).toHaveBeenCalledTimes(1);
    expect(sleepWithSignal).toHaveBeenCalledWith(SIM_BALANCES_OWNER_GROUP_DELAY_MS, undefined);
    expect(setCacheIfNewer).toHaveBeenCalledTimes(1);
    expect(recordOutcomeSafe).toHaveBeenCalledWith(db, "sim-balances", true);
  });
});
