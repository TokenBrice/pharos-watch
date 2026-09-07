import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { loadBlacklistConfigStates } from "../sync-support";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { normalizeBlacklistSyncStateKey } from "../../../lib/db";
import { excludeFrozenIds } from "../../shared/exclude-frozen";

const ELIGIBLE = excludeFrozenIds(CONTRACT_CONFIGS, (c) => c.stablecoinId);

describe("loadBlacklistConfigStates", () => {
  it("issues a single bulk blacklist_sync_state query instead of one per config", async () => {
    const db = mockD1([{ match: "FROM blacklist_sync_state", rows: [] }]);

    await loadBlacklistConfigStates(db);

    const syncStateQueries = db.getHistory().filter((entry) => entry.sql.includes("blacklist_sync_state"));
    expect(syncStateQueries).toHaveLength(1);
  });

  it("retries the bulk blacklist_sync_state query after transient D1 overload", async () => {
    const first = ELIGIBLE[0];
    let attempts = 0;
    const db = makeNoopD1({
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
    });

    const { configStates } = await loadBlacklistConfigStates(db);

    expect(attempts).toBe(2);
    expect(configStates.find((state) => state.configKey === first.configKey)?.cursorValue).toBe(4321);
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
    expect(firstState?.cursorValue).toBe(4321);
    expect(zeroCursorConfigs).not.toContain(first.configKey);
    // Every other eligible config has no row → cursor 0.
    for (const state of configStates) {
      if (state.configKey === first.configKey) continue;
      expect(state.cursorValue).toBe(0);
      expect(zeroCursorConfigs).toContain(state.configKey);
    }
  });

  it("matches a row stored under the normalized config key", async () => {
    // Pick a config whose key normalizes to a distinct value (mixed-case
    // contract address, non-tron prefix); skip if none exist in the registry.
    const target = ELIGIBLE.find((c) => normalizeBlacklistSyncStateKey(c.configKey) !== c.configKey);
    if (!target) return;

    const db = mockD1([
      {
        match: "FROM blacklist_sync_state",
        rows: [{ config_key: normalizeBlacklistSyncStateKey(target.configKey), last_block: 999 }],
      },
    ]);

    const { configStates } = await loadBlacklistConfigStates(db);
    const state = configStates.find((s) => s.configKey === target.configKey);
    expect(state?.cursorValue).toBe(999);
  });

  it("loads typed attempt state while dual-reading legacy last_block", async () => {
    const first = ELIGIBLE[0];
    const db = mockD1([
      {
        match: "FROM blacklist_sync_state",
        rows: [
          {
            config_key: first.configKey,
            last_block: 4_321,
            cursor_value: 4_300,
            attempt_generation: 7,
            last_attempted_at: 1_700_000_100,
            last_succeeded_at: 1_700_000_000,
            last_skipped_at: 1_699_000_000,
            last_failed_at: null,
            consecutive_skips: 0,
            consecutive_failures: 0,
            last_outcome: "quiet",
          },
        ],
      },
    ]);

    const { configStates } = await loadBlacklistConfigStates(db);
    const state = configStates.find((candidate) => candidate.configKey === first.configKey);

    expect(state).toMatchObject({
      cursorValue: 4_321,
      attemptGeneration: 7,
      lastAttemptedAt: 1_700_000_100,
      lastSucceededAt: 1_700_000_000,
      lastOutcome: "quiet",
    });
    expect(state?.cursorKind).toBe(first.chain.type === "tron" ? "tron_timestamp_ms" : "evm_block");
  });
});
