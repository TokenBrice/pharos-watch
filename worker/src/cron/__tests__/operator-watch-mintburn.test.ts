import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import {
  MINT_BURN_EXTENDED_ATTEMPT_STATE_KEY,
  loadMintBurnStuckConfigWatchConditions,
} from "../operator-watch-mintburn";

const NOW = 1_775_900_000;
const config = MINT_BURN_CONFIGS.find(
  (candidate) => candidate.enabled !== false && WORKER_ACTIVE_IDS.has(candidate.stablecoinId),
)!;
const configKey = mintBurnConfigKey(config);

function attemptState(consecutiveIncomplete: number) {
  return JSON.stringify({
    version: 1,
    updatedAt: NOW - 60,
    entries: {
      [configKey]: {
        firstObservedAt: NOW - 86_400,
        lastAttemptedAt: NOW - 60,
        lastDisposition: "attempted",
        providerDeferredUntil: null,
        consecutiveIncomplete,
      },
    },
  });
}

function cacheRow(value: string) {
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: [MINT_BURN_EXTENDED_ATTEMPT_STATE_KEY],
    rows: [{ key: MINT_BURN_EXTENDED_ATTEMPT_STATE_KEY, value, updated_at: NOW - 60 }],
  };
}

describe("mint/burn stuck config watch conditions", () => {
  it("raises a config attempted twice without advancing", async () => {
    const db = mockD1([cacheRow(attemptState(2))]);

    const result = await loadMintBurnStuckConfigWatchConditions(db);

    expect(result.readFailed).toBe(false);
    expect(result.conditions).toEqual([{
      // A dedicated section lets the absent condition report a recovery.
      section: "mint-burn-config",
      id: configKey,
      label: expect.stringContaining("2 incomplete attempts"),
      active: true,
    }]);
  });

  it("does not raise a single incomplete attempt", async () => {
    const db = mockD1([cacheRow(attemptState(1))]);

    const result = await loadMintBurnStuckConfigWatchConditions(db);

    expect(result).toMatchObject({ conditions: [], readFailed: false });
  });

  it("reports a missing or unreadable attempt state instead of healthy configs", async () => {
    await expect(loadMintBurnStuckConfigWatchConditions(mockD1([]))).resolves.toEqual({
      conditions: [],
      readFailed: true,
    });
    const unreadable = mockD1([cacheRow("{not-json")]);
    await expect(loadMintBurnStuckConfigWatchConditions(unreadable)).resolves.toEqual({
      conditions: [],
      readFailed: true,
    });
  });
});
