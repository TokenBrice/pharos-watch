import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { BLACKLIST_CONFIG_STALE_AGE_SEC, loadBlacklistConfigWatchConditions } from "../operator-watch-blacklist";

const NOW = 1_775_900_000;
const config = CONTRACT_CONFIGS.find((candidate) => WORKER_ACTIVE_IDS.has(candidate.stablecoinId))!;

function syncStateRow(lastSucceededAt: number | null, lastAttemptedAt: number | null) {
  return {
    config_key: config.configKey,
    last_block: 100,
    cursor_value: null,
    attempt_generation: 1,
    last_attempted_at: lastAttemptedAt,
    last_succeeded_at: lastSucceededAt,
    last_skipped_at: null,
    last_failed_at: null,
    consecutive_skips: 0,
    consecutive_failures: 0,
    last_outcome: "attempted",
  };
}

describe("blacklist config watch conditions", () => {
  it("raises the config that has not succeeded for two producer intervals", async () => {
    const db = mockD1([{
      match: "FROM blacklist_sync_state",
      rows: [syncStateRow(NOW - BLACKLIST_CONFIG_STALE_AGE_SEC - 1, NOW - 60)],
    }]);

    const result = await loadBlacklistConfigWatchConditions(db, NOW);

    expect(result.readFailed).toBe(false);
    expect(result.conditions.find((condition) => condition.id === `sync-blacklist:${config.configKey}`))
      .toMatchObject({
        section: "producer",
        active: true,
        label: expect.stringContaining(config.stablecoin),
      });
  });

  it("leaves a config that succeeded inside the budget recoverable", async () => {
    const db = mockD1([{
      match: "FROM blacklist_sync_state",
      rows: [syncStateRow(NOW - 60, NOW - 60)],
    }]);

    const result = await loadBlacklistConfigWatchConditions(db, NOW);

    expect(result.conditions.find((condition) => condition.id === `sync-blacklist:${config.configKey}`))
      .toMatchObject({ active: false });
  });

  it("raises a config that has never succeeded once it has been attempted", async () => {
    const db = mockD1([{
      match: "FROM blacklist_sync_state",
      rows: [syncStateRow(null, NOW - 60)],
    }]);

    const result = await loadBlacklistConfigWatchConditions(db, NOW);

    expect(result.conditions.find((condition) => condition.id === `sync-blacklist:${config.configKey}`))
      .toMatchObject({
        active: true,
        label: expect.stringContaining("never succeeded"),
      });
  });

  it("reports a failed config-state read instead of healthy conditions", async () => {
    const db = mockD1([{
      match: "FROM blacklist_sync_state",
      throwError: new Error("D1 unavailable"),
      rows: [],
    }]);

    await expect(loadBlacklistConfigWatchConditions(db, NOW)).resolves.toEqual({
      conditions: [],
      readFailed: true,
    });
  });
});
