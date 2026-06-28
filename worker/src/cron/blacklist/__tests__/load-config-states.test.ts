import { describe, expect, it } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { loadBlacklistConfigStates } from "../sync-support";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { normalizeBlacklistSyncStateKey } from "../../../lib/db";
import { excludeFrozenIds } from "../../shared/exclude-frozen";

const ELIGIBLE = excludeFrozenIds(CONTRACT_CONFIGS, (c) => c.stablecoinId);

describe("loadBlacklistConfigStates", () => {
  it("issues a single bulk blacklist_sync_state query instead of one per config", async () => {
    const db = mockD1([{ match: "FROM blacklist_sync_state", rows: [] }]);

    await loadBlacklistConfigStates(db);

    const syncStateQueries = db
      .getHistory()
      .filter((entry) => entry.sql.includes("blacklist_sync_state"));
    expect(syncStateQueries).toHaveLength(1);
  });

  it("retries the bulk blacklist_sync_state query after transient D1 overload", async () => {
    const first = ELIGIBLE[0];
    let attempts = 0;
    const db = {
      prepare: () => ({
        all: async () => {
          attempts++;
          if (attempts === 1) throw new Error("D1 DB is overloaded");
          return {
            results: [{ config_key: first.configKey, last_block: 4321 }],
            success: true,
            meta: {},
          };
        },
      }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { configStates } = await loadBlacklistConfigStates(db);

    expect(attempts).toBe(2);
    expect(configStates.find((state) => state.configKey === first.configKey)?.lastBlock).toBe(4321);
  });

  it("joins last_block per config in-memory and defaults missing configs to 0", async () => {
    const first = ELIGIBLE[0];
    const db = mockD1([
      {
        match: "FROM blacklist_sync_state",
        rows: [{ config_key: first.configKey, last_block: 4321 }],
      },
    ]);

    const { configStates, zeroCursorConfigs } = await loadBlacklistConfigStates(db);

    const firstState = configStates.find((state) => state.configKey === first.configKey);
    expect(firstState?.lastBlock).toBe(4321);
    expect(zeroCursorConfigs).not.toContain(first.configKey);
    // Every other eligible config has no row → cursor 0.
    for (const state of configStates) {
      if (state.configKey === first.configKey) continue;
      expect(state.lastBlock).toBe(0);
      expect(zeroCursorConfigs).toContain(state.configKey);
    }
  });

  it("matches a row stored under the normalized config key", async () => {
    // Pick a config whose key normalizes to a distinct value (mixed-case
    // contract address, non-tron prefix); skip if none exist in the registry.
    const target = ELIGIBLE.find(
      (c) => normalizeBlacklistSyncStateKey(c.configKey) !== c.configKey,
    );
    if (!target) return;

    const db = mockD1([
      {
        match: "FROM blacklist_sync_state",
        rows: [
          { config_key: normalizeBlacklistSyncStateKey(target.configKey), last_block: 999 },
        ],
      },
    ]);

    const { configStates } = await loadBlacklistConfigStates(db);
    const state = configStates.find((s) => s.configKey === target.configKey);
    expect(state?.lastBlock).toBe(999);
  });
});
