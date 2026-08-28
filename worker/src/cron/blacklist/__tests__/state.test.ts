import { describe, expect, it } from "vitest";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { mockD1 } from "@shared/test-utils/mock-d1";
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

  it("claims with the loaded generation and cursor", async () => {
    const db = mockD1([
      { match: "blacklist-state-bootstrap", rows: [], runMeta: { changes: 0 } },
      { match: "blacklist-state-claim", rows: [], runMeta: { changes: 1 } },
    ]);
    const state = makeState(EVM_CONFIG, { cursorValue: 482_000_000, attemptGeneration: 7 });

    await expect(claimBlacklistConfigAttempt(db, state, 1_700_000_000)).resolves.toMatchObject({
      expectedCursor: 482_000_000,
      generation: 8,
    });
    const claim = db.getHistory().find((entry) => entry.sql.includes("blacklist-state-claim"));
    expect(claim?.binds.slice(-2)).toEqual([7, 482_000_000]);
  });

  it("rejects a concurrent claim without changing the cursor", async () => {
    const db = mockD1([
      { match: "blacklist-state-bootstrap", rows: [], runMeta: { changes: 0 } },
      { match: "blacklist-state-claim", rows: [], runMeta: { changes: 0 } },
    ]);

    await expect(claimBlacklistConfigAttempt(db, makeState(EVM_CONFIG), 1_700_000_000)).resolves.toBeNull();
  });

  it("dual-writes a monotonic cursor under the claimed generation", async () => {
    const db = mockD1([{ match: "blacklist-state-finalize", rows: [], runMeta: { changes: 1 } }]);

    await expect(
      finalizeBlacklistConfigAttempt(
        db,
        {
          configKey: EVM_CONFIG.configKey,
          cursorKind: "evm_block",
          expectedCursor: 500,
          generation: 4,
          attemptedAt: 1_700_000_000,
        },
        {
          outcome: "quiet",
          nextCursor: 400,
          observedSafeHead: 700,
          completedAt: 1_700_000_100,
        },
      ),
    ).resolves.toBe(true);

    const finalize = db.getHistory()[0]!;
    expect(finalize.binds[0]).toBe(500);
    expect(finalize.binds[1]).toBe(500);
    expect(finalize.binds.slice(-3)).toEqual([EVM_CONFIG.configKey.toLowerCase(), 4, 500]);
  });

  it("does not accept a late finalizer after its generation is superseded", async () => {
    const db = mockD1([{ match: "blacklist-state-finalize", rows: [], runMeta: { changes: 0 } }]);

    await expect(
      finalizeBlacklistConfigAttempt(
        db,
        {
          configKey: EVM_CONFIG.configKey,
          cursorKind: "evm_block",
          expectedCursor: 500,
          generation: 4,
          attemptedAt: 1_700_000_000,
        },
        {
          outcome: "complete",
          nextCursor: 600,
          completedAt: 1_700_000_100,
        },
      ),
    ).resolves.toBe(false);
  });

  it("records budget skips without advancing a cursor", async () => {
    const db = mockD1([{ match: "blacklist-state-budget-skip", rows: [], runMeta: { changes: 1 } }]);
    const states = [makeState(EVM_CONFIG, { cursorValue: 123 })];

    await recordBlacklistConfigSkips(db, states, 1_700_000_000);

    const write = db.getHistory()[0]!;
    expect(write.binds.slice(0, 5)).toEqual([EVM_CONFIG.configKey.toLowerCase(), 123, "evm_block", 123, 1_700_000_000]);
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
