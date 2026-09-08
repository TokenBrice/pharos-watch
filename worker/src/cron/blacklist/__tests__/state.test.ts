import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { loadBlacklistConfigStates } from "../sync-support";
import {
  claimBlacklistConfigAttempt,
  finalizeBlacklistConfigAttempt,
  getOldestBlacklistSuccessAt,
  inferBlacklistCursorKind,
  orderBlacklistConfigStatesFairly,
  recordBlacklistConfigSkips,
  type BlacklistConfigState,
} from "../state";

const EVM_CONFIG = CONTRACT_CONFIGS.find((config) => config.chain.type !== "tron")!;
const TRON_CONFIG = CONTRACT_CONFIGS.find((config) => config.chain.type === "tron")!;

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function makeState(config: typeof EVM_CONFIG, overrides: Partial<BlacklistConfigState> = {}): BlacklistConfigState {
  return {
    config,
    configKey: config.configKey,
    cursorKind: inferBlacklistCursorKind(config),
    cursorValue: 0,
    attemptGeneration: 0,
    lastAttemptedAt: null,
    lastSucceededAt: null,
    lastSkippedAt: null,
    lastFailedAt: null,
    consecutiveSkips: 0,
    consecutiveFailures: 0,
    lastOutcome: null,
    ...overrides,
  };
}

describe("blacklist fair state", () => {
  it("orders by attempt time instead of incomparable cursor units", () => {
    const states = [
      makeState(EVM_CONFIG, { configKey: "evm-c", cursorValue: 482_000_000 }),
      makeState(EVM_CONFIG, { configKey: "evm-a", cursorValue: 24_000_000 }),
      makeState(TRON_CONFIG, { configKey: "tron-b", cursorValue: 1_783_000_000_000 }),
      makeState(EVM_CONFIG, { configKey: "evm-b", cursorValue: 99_000_000 }),
      makeState(TRON_CONFIG, { configKey: "tron-a", cursorValue: 1_782_000_000_000 }),
    ];

    expect(orderBlacklistConfigStatesFairly(states).map((state) => state.configKey)).toEqual([
      "tron-a",
      "evm-a",
      "tron-b",
      "evm-b",
      "evm-c",
    ]);
  });

  it("puts never-attempted tail configs ahead on the next run", () => {
    const states = [
      makeState(EVM_CONFIG, { configKey: "evm-old-a" }),
      makeState(EVM_CONFIG, { configKey: "evm-old-b" }),
      makeState(TRON_CONFIG, { configKey: "tron-recent", lastAttemptedAt: 1_700_000_100 }),
      makeState(EVM_CONFIG, { configKey: "evm-recent", lastAttemptedAt: 1_700_000_000 }),
    ];

    expect(
      orderBlacklistConfigStatesFairly(states)
        .slice(0, 2)
        .map((state) => state.configKey),
    ).toEqual(["evm-old-a", "evm-old-b"]);
  });

  it("rejects concurrent claims and stale finalizers/skips without changing durable state", async () => {
    const { db, sqlite } = fixtures.open();
    const key = EVM_CONFIG.configKey.toLowerCase();
    sqlite.prepare(`INSERT INTO blacklist_sync_state
      (config_key, last_block, cursor_value, attempt_generation) VALUES (?, 500, 500, 7)`).run(key);
    const load = async () => (await loadBlacklistConfigStates(db)).configStates
      .find((state) => state.configKey === EVM_CONFIG.configKey)!;
    const firstRead = await load();
    const concurrentRead = await load();
    const firstClaim = await claimBlacklistConfigAttempt(db, firstRead, 100);
    expect(firstClaim).toMatchObject({ generation: 8, expectedCursor: 500 });
    await expect(claimBlacklistConfigAttempt(db, concurrentRead, 101)).resolves.toBeNull();
    const newerClaim = await claimBlacklistConfigAttempt(db, await load(), 102);
    expect(newerClaim).toMatchObject({ generation: 9, expectedCursor: 500 });
    const durableBefore = sqlite.prepare("SELECT * FROM blacklist_sync_state WHERE config_key = ?").get(key);
    await expect(finalizeBlacklistConfigAttempt(db, firstClaim!, {
      outcome: "complete", nextCursor: 600, completedAt: 103,
    })).resolves.toBe(false);
    await recordBlacklistConfigSkips(db, [concurrentRead], 104);
    expect(sqlite.prepare("SELECT * FROM blacklist_sync_state WHERE config_key = ?").get(key)).toEqual(durableBefore);
    await expect(finalizeBlacklistConfigAttempt(db, newerClaim!, {
      outcome: "quiet", nextCursor: 400, observedSafeHead: 700, completedAt: 105,
    })).resolves.toBe(true);
    expect(sqlite.prepare("SELECT * FROM blacklist_sync_state WHERE config_key = ?").get(key)).toMatchObject({
      last_block: 500, cursor_value: 500, attempt_generation: 9,
      last_succeeded_at: 105, last_outcome: "quiet", last_observed_safe_head: 700,
    });
  });

  it("rejects cursor-stale claims, finalizers and skips even when generation matches", async () => {
    const { db, sqlite } = fixtures.open();
    const state = makeState(EVM_CONFIG, { cursorValue: 500 });
    const claim = await claimBlacklistConfigAttempt(db, state, 100);
    expect(claim).not.toBeNull();
    sqlite.prepare("UPDATE blacklist_sync_state SET last_block = 600, cursor_value = 600").run();
    const stale = makeState(EVM_CONFIG, { cursorValue: 500, attemptGeneration: 1 });
    await expect(claimBlacklistConfigAttempt(db, stale, 101)).resolves.toBeNull();
    await expect(finalizeBlacklistConfigAttempt(db, claim!, {
      outcome: "complete", nextCursor: 700, completedAt: 102,
    })).resolves.toBe(false);
    await recordBlacklistConfigSkips(db, [stale], 103);
    expect(sqlite.prepare("SELECT * FROM blacklist_sync_state WHERE config_key = ?").get(claim!.configKey)).toMatchObject({
      last_block: 600, cursor_value: 600, attempt_generation: 1, last_outcome: "running", last_skipped_at: null,
    });
  });

  it("records budget skips without advancing a cursor", async () => {
    const { db, sqlite } = fixtures.open();
    const state = makeState(EVM_CONFIG, { cursorValue: 123 });
    await recordBlacklistConfigSkips(db, [state], 100);
    await recordBlacklistConfigSkips(db, [state], 101);
    expect(sqlite.prepare("SELECT * FROM blacklist_sync_state WHERE config_key = ?").get(state.configKey.toLowerCase())).toMatchObject({
      last_block: 123, cursor_value: 123, last_skipped_at: 101,
      consecutive_skips: 2, attempt_generation: 0, last_outcome: "budget_skipped",
    });
  });

  it("uses the oldest required successful scan as producer freshness", () => {
    expect(
      getOldestBlacklistSuccessAt([
        makeState(EVM_CONFIG, { lastSucceededAt: 200 }),
        makeState(TRON_CONFIG, { lastSucceededAt: 100 }),
      ]),
    ).toEqual({ oldestSuccessAt: 100, neverSucceeded: 0 });
    expect(
      getOldestBlacklistSuccessAt([makeState(EVM_CONFIG, { lastSucceededAt: 200 }), makeState(TRON_CONFIG)]),
    ).toEqual({ oldestSuccessAt: null, neverSucceeded: 1 });
  });
});
