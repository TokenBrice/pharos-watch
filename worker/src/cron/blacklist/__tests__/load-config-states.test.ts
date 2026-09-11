import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { loadBlacklistConfigStates } from "../sync-support";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { normalizeBlacklistSyncStateKey } from "../../../lib/db";
vi.mock("../../../lib/blacklist-contracts", () => ({
  CONTRACT_CONFIGS: [
    {
      configKey: "ethereum-0xAbCd",
      stablecoinId: "usdt-tether",
      stablecoin: "USDT",
      chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, type: "evm", explorerUrl: "https://etherscan.io" },
      contractAddress: "0xAbCd",
      decimals: 6,
      events: [],
    },
    {
      configKey: "ethereum-0xEf01",
      stablecoinId: "usdc-circle",
      stablecoin: "USDC",
      chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, type: "evm", explorerUrl: "https://etherscan.io" },
      contractAddress: "0xEf01",
      decimals: 6,
      events: [],
    },
  ],
}));

const ELIGIBLE = CONTRACT_CONFIGS;
afterEach(() => vi.useRealTimers());

describe("loadBlacklistConfigStates", () => {
  it("issues a single bulk blacklist_sync_state query instead of one per config", async () => {
    const db = mockD1([{ match: "FROM blacklist_sync_state", rows: [] }]);

    await loadBlacklistConfigStates(db);

    const syncStateQueries = db.getHistory().filter((entry) => entry.sql.includes("blacklist_sync_state"));
    expect(syncStateQueries).toHaveLength(1);
  });

  it("retries the bulk blacklist_sync_state query after transient D1 overload", async () => {
    vi.useFakeTimers();
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

    const pending = loadBlacklistConfigStates(db);
    await vi.runAllTimersAsync();
    const { configStates } = await pending;

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
    const target = ELIGIBLE[0]!;

    const db = mockD1([
      {
        match: "FROM blacklist_sync_state",
        rows: [
          { config_key: target.configKey, last_block: 999, attempt_generation: 2 },
          { config_key: normalizeBlacklistSyncStateKey(target.configKey), last_block: 500, cursor_value: 700, attempt_generation: 8 },
        ],
      },
    ]);

    const { configStates } = await loadBlacklistConfigStates(db);
    const state = configStates.find((s) => s.configKey === target.configKey);
    expect(state).toMatchObject({ configKey: target.configKey, cursorValue: 999, attemptGeneration: 8 });
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
