import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  buildBaselineMap,
  buildCoinCoverageMap,
  cachedFlowFallbackResponse,
  finalizeMintBurnFlowResponse,
  ETHEREUM_CHAIN_ID,
  readCachedFlow,
  readMintBurnCronSnapshot,
  readMintBurnCronSnapshotResult,
  selectLargestEvents,
} from "../../lib/mint-burn-flows-service";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { mintBurnScenario } from "../../test-helpers/__shared/mint-burn";

describe("readCachedFlow", () => {
  it("returns only the requested cached window and rejects missing entries", async () => {
    const db = mintBurnScenario({ flowCache: [
      { key: "mint-burn-flows:v4:aggregate:24", value: '{"windowHours":24}', updatedAt: 100 },
      { key: "mint-burn-flows:v4:aggregate:48", value: '{"windowHours":48}', updatedAt: 200 },
    ] });
    await expect(readCachedFlow(db, "mint-burn-flows:v4:aggregate:48"))
      .resolves.toEqual({ value: '{"windowHours":48}', updatedAt: 200 });
    await expect(readCachedFlow(db, "mint-burn-flows:v4:aggregate:72")).resolves.toBeNull();
  });
});

describe("cachedFlowFallbackResponse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives freshness headers from embedded sync metadata when present", async () => {
    const syncTs = Math.floor(Date.now() / 1000) - 90;
    const response = cachedFlowFallbackResponse({
      updatedAt: syncTs - 300,
      value: JSON.stringify({
        updatedAt: syncTs - 200,
        sync: { lastSuccessfulSyncAt: syncTs },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Age")).toBe("90");
    expect(response.headers.get("Warning")).toBeNull();
  });

  it.each([null, undefined])("does not replace an absent cached sync timestamp (%s) with response generation time", async (lastSuccessfulSyncAt) => {
    const now = Math.floor(Date.now() / 1000);
    const body = {
      updatedAt: now,
      sync: { lastSuccessfulSyncAt, warning: "Mint/burn sync unavailable" },
    };
    const response = cachedFlowFallbackResponse({ updatedAt: now, value: JSON.stringify(body) });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Data-Age")).toBe("unavailable");
    expect(response.headers.get("Warning")).toMatch(/^199 /);
    await expect(response.json()).resolves.toMatchObject({ sync: { warning: body.sync.warning } });
  });

  it("marks a fresh response with no sync timestamp unavailable while preserving its sync warning", async () => {
    const now = Math.floor(Date.now() / 1000);
    const body = { sync: { lastSuccessfulSyncAt: null, warning: "Mint/burn sync unavailable" } };
    const response = await finalizeMintBurnFlowResponse(
      mockD1([{ match: "INSERT INTO cache (key, value, updated_at)", rows: [], runMeta: { changes: 1 } }]),
      "mint-burn-flows:v4:aggregate:24",
      now,
      body,
      { timestamp: null, status: "missing" },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Data-Age")).toBe("unavailable");
    expect(response.headers.get("Warning")).toMatch(/^199 /);
    await expect(response.json()).resolves.toMatchObject({ ...body, _meta: { updatedAt: null, ageSeconds: null, reason: "producer-history-missing" } });
  });

  it("preserves a failed producer lookup through cache fallback headers and body", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([{ match: "INSERT INTO cache (key, value, updated_at)", rows: [], runMeta: { changes: 1 } }]);
    const response = await finalizeMintBurnFlowResponse(db, "flows", now, {
      sync: { lastSuccessfulSyncAt: null },
    }, { timestamp: null, status: "lookup_failed" });
    const body = await response.text();
    const cached = cachedFlowFallbackResponse({ value: body, updatedAt: now });
    expect(cached.headers.get("X-Data-Freshness")).toBe("unknown");
    expect(cached.headers.get("X-Data-Freshness-Reason")).toBe("freshness-lookup-failed");
    expect(cached.headers.get("X-Data-Age")).toBe("unavailable");
    expect(cached.headers.get("Cache-Control")).toBe("no-store");
    expect(await cached.json()).toMatchObject({ _meta: { status: "unknown", reason: "freshness-lookup-failed" } });
  });

  it("returns 503 when the cached body is malformed JSON", async () => {
    const response = cachedFlowFallbackResponse({
      updatedAt: Math.floor(Date.now() / 1000) - 10,
      value: "{bad-json",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Cached mint-burn-flows payload is malformed",
    });
  });
});

describe("selectLargestEvents", () => {
  it("prefers larger USD value, then newer timestamp, then newer block, then lexicographically later id", () => {
    const selected = selectLargestEvents([
      {
        id: "a",
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        chain_id: ETHEREUM_CHAIN_ID,
        direction: "mint",
        amount: 100,
        amount_usd: 100,
        counterparty: null,
        tx_hash: "0x1",
        block_number: 10,
        timestamp: 1000,
        explorer_tx_url: "https://example.com/1",
      },
      {
        id: "b",
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        chain_id: ETHEREUM_CHAIN_ID,
        direction: "mint",
        amount: 80,
        amount_usd: 200,
        counterparty: null,
        tx_hash: "0x2",
        block_number: 9,
        timestamp: 999,
        explorer_tx_url: "https://example.com/2",
      },
      {
        id: "c",
        stablecoin_id: "usdc-circle",
        symbol: "USDC",
        chain_id: ETHEREUM_CHAIN_ID,
        direction: "burn",
        amount: 50,
        amount_usd: 50,
        counterparty: null,
        tx_hash: "0x3",
        block_number: 12,
        timestamp: 1001,
        explorer_tx_url: "https://example.com/3",
      },
    ]);

    expect(selected.get("usdt-tether")?.id).toBe("b");
    expect(selected.get("usdc-circle")?.id).toBe("c");
  });

  it("does not let unpriced raw token amounts outrank priced largest events", () => {
    const selected = selectLargestEvents([
      {
        id: "unpriced",
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        chain_id: ETHEREUM_CHAIN_ID,
        direction: "mint",
        amount: 100_000_000,
        amount_usd: null,
        counterparty: null,
        tx_hash: "0xunpriced",
        block_number: 11,
        timestamp: 1001,
        explorer_tx_url: "https://example.com/unpriced",
      },
      {
        id: "priced",
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        chain_id: ETHEREUM_CHAIN_ID,
        direction: "mint",
        amount: 100,
        amount_usd: 100,
        counterparty: null,
        tx_hash: "0xpriced",
        block_number: 10,
        timestamp: 1000,
        explorer_tx_url: "https://example.com/priced",
      },
    ]);

    expect(selected.get("usdt-tether")?.id).toBe("priced");
  });
});

describe("readMintBurnCronSnapshot", () => {
  it("returns null chainHead when cron metadata is malformed", async () => {
    const db = mockD1([
      {
        match: "SELECT started_at, status, metadata",
        rows: [],
        first: {
          started_at: 1_700_000_000,
          status: "ok",
          metadata: "{bad-json",
        },
      },
    ]);

    await expect(readMintBurnCronSnapshot(db)).resolves.toEqual({
      startedAt: 1_700_000_000,
      status: "ok",
      chainHead: null,
      chainHeads: new Map(),
    });
  });

  it("returns null fields when no cron row exists", async () => {
    const db = mockD1([
      {
        match: "SELECT started_at, status, metadata",
        rows: [],
        first: null,
      },
    ]);

    await expect(readMintBurnCronSnapshot(db)).resolves.toEqual({
      startedAt: null,
      status: null,
      chainHead: null,
      chainHeads: new Map(),
    });
  });

  it("preserves a typed D1 snapshot failure and marks coverage unavailable", async () => {
    const db = mockD1([
      {
        match: "SELECT started_at, status, metadata",
        rows: [],
        throwError: new Error("D1 snapshot unavailable"),
      },
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const snapshot = await readMintBurnCronSnapshotResult(db);
      expect(snapshot.value).toEqual({
        startedAt: null,
        status: null,
        chainHead: null,
        chainHeads: new Map(),
      });
      expect(snapshot.error).toEqual(new Error("D1 snapshot unavailable"));

      const config = MINT_BURN_CONFIGS[0]!;
      const coverage = buildCoinCoverageMap(
        1_700_000_000,
        [],
        new Map(),
        snapshot.value.chainHeads,
        snapshot.error ? "cron-snapshot-unavailable" : null,
      );
      expect(coverage.get(config.stablecoinId)?.unavailableReason).toBe("cron-snapshot-unavailable");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("cron-snapshot-read-failed"));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("buildBaselineMap", () => {
  const day = (
    stablecoin_id: string,
    chain_id: string,
    dayIndex: number,
    daily_net: number,
    daily_abs: number,
    tally: Partial<Record<"unpriced_mint_event_count" | "unpriced_burn_event_count" | "unknown_mint_hours" | "unknown_burn_hours", number>> = {},
  ) => ({
    stablecoin_id,
    chain_id,
    day_ts: dayIndex * DAY_SECONDS,
    daily_net,
    daily_abs,
    unpriced_mint_event_count: 0,
    unpriced_burn_event_count: 0,
    unknown_mint_hours: 0,
    unknown_burn_hours: 0,
    ...tally,
  });

  it("averages across tracked days, including days with no activity", () => {
    const nowSec = 4 * DAY_SECONDS + 1;
    const baseline = buildBaselineMap(
      nowSec,
      [
        day("usdt-tether", ETHEREUM_CHAIN_ID, 1, 30, 50),
        day("usdt-tether", ETHEREUM_CHAIN_ID, 2, -15, 25),
      ],
      [
        { stablecoin_id: "usdt-tether", chain_id: ETHEREUM_CHAIN_ID, first_hour_ts: 1 * DAY_SECONDS + 3600 },
      ],
    );

    expect(baseline.get("usdt-tether")).toEqual({
      avgNet: 5,
      avgAbs: 25,
      dataDays: 3,
      valuation: "complete",
    });
  });

  it("cross-chain-aggregates daily_net and daily_abs before averaging across days", () => {
    // Day 1: chain A nets +100 abs 200, chain B nets -40 abs 60 → combined net=60, abs=260
    // Day 2: chain A nets +20 abs 30 → combined net=20, abs=30
    // nowSec in day 3 → baselineEndDayTs = day 2, firstDayTs = day 1, dataDays = 2
    const nowSec = 3 * DAY_SECONDS + 1;
    const baseline = buildBaselineMap(
      nowSec,
      [
        day("usdc-circle", "ethereum", 1, 100, 200),
        day("usdc-circle", "arbitrum", 1, -40, 60),
        day("usdc-circle", "ethereum", 2, 20, 30),
      ],
      [
        { stablecoin_id: "usdc-circle", chain_id: "ethereum", first_hour_ts: 1 * DAY_SECONDS },
        { stablecoin_id: "usdc-circle", chain_id: "arbitrum", first_hour_ts: 1 * DAY_SECONDS + 7200 },
      ],
    );

    // sumNet = 60 + 20 = 80, sumAbs = 260 + 30 = 290, dataDays = 2
    expect(baseline.get("usdc-circle")).toEqual({
      avgNet: 40,
      avgAbs: 145,
      dataDays: 2,
      valuation: "complete",
    });
  });

  it("qualifies the baseline with the valuation of its own days only", () => {
    // nowSec in day 4 → baseline days 1..3; day 4 (today) is outside the baseline.
    const nowSec = 4 * DAY_SECONDS + 1;
    const firstSeen = (id: string) => [{ stablecoin_id: id, chain_id: ETHEREUM_CHAIN_ID, first_hour_ts: 1 * DAY_SECONDS }];
    const partial = buildBaselineMap(nowSec, [
      day("partial-coin", ETHEREUM_CHAIN_ID, 2, -10, 10, { unpriced_burn_event_count: 1, unknown_mint_hours: 3 }),
    ], firstSeen("partial-coin"));
    const unknown = buildBaselineMap(nowSec, [
      day("legacy-coin", ETHEREUM_CHAIN_ID, 2, 10, 10, { unknown_mint_hours: 1 }),
    ], firstSeen("legacy-coin"));
    const todayOnly = buildBaselineMap(nowSec, [
      day("today-coin", ETHEREUM_CHAIN_ID, 4, 10, 10, { unpriced_mint_event_count: 2 }),
    ], firstSeen("today-coin"));

    expect(partial.get("partial-coin")?.valuation).toBe("partial");
    expect(unknown.get("legacy-coin")?.valuation).toBe("unknown");
    expect(todayOnly.get("today-coin")).toEqual({ avgNet: 0, avgAbs: 0, dataDays: 3, valuation: "complete" });
  });

  it("produces no entry when coin is first seen today (firstDayTs > baselineEndDayTs)", () => {
    // nowSec is within day 5 → baselineEndDayTs = day 4
    // first_hour_ts is within day 5 → firstDayTs = day 5 > day 4 → skipped
    const nowSec = 5 * DAY_SECONDS + 100;
    const baseline = buildBaselineMap(
      nowSec,
      [
        day("new-coin", ETHEREUM_CHAIN_ID, 5, 10, 10),
      ],
      [
        { stablecoin_id: "new-coin", chain_id: ETHEREUM_CHAIN_ID, first_hour_ts: 5 * DAY_SECONDS + 50 },
      ],
    );

    expect(baseline.has("new-coin")).toBe(false);
  });

  it("caps dataDays at 30 when coin has been tracked for exactly 30 days", () => {
    // firstDayTs = day 1, baselineEndDayTs = day 30 → trackedDays = 30, dataDays = 30
    const nowSec = 31 * DAY_SECONDS + 1;
    const baseline = buildBaselineMap(
      nowSec,
      [
        day("old-coin", ETHEREUM_CHAIN_ID, 1, 300, 300),
      ],
      [
        { stablecoin_id: "old-coin", chain_id: ETHEREUM_CHAIN_ID, first_hour_ts: 1 * DAY_SECONDS },
      ],
    );

    expect(baseline.get("old-coin")).toEqual({
      avgNet: 10,
      avgAbs: 10,
      dataDays: 30,
      valuation: "complete",
    });
  });

  it("sets dataDays to actual tracked days when coin has fewer than 30 days", () => {
    // firstDayTs = day 10, baselineEndDayTs = day 20 → trackedDays = 11, dataDays = 11
    const nowSec = 21 * DAY_SECONDS + 1;
    const baseline = buildBaselineMap(
      nowSec,
      [
        day("young-coin", ETHEREUM_CHAIN_ID, 15, 55, 55),
      ],
      [
        { stablecoin_id: "young-coin", chain_id: ETHEREUM_CHAIN_ID, first_hour_ts: 10 * DAY_SECONDS },
      ],
    );

    expect(baseline.get("young-coin")).toEqual({
      avgNet: 5,
      avgAbs: 5,
      dataDays: 11,
      valuation: "complete",
    });
  });
});

describe("buildCoinCoverageMap", () => {
  // Pick a single-config Ethereum coin for isolation in each test.
  function pickSingleConfigCoin() {
    const config = MINT_BURN_CONFIGS.find((entry) => entry.chain.chainId === ETHEREUM_CHAIN_ID);
    expect(config).toBeDefined();
    return config!;
  }

  it("marks a well-synced long-history coin as full coverage", () => {
    const config = pickSingleConfigCoin();
    const referenceHead = config.startBlock + 1_000_000;
    const coverage = buildCoinCoverageMap(
      200 * DAY_SECONDS,
      [{ stablecoin_id: config.stablecoinId, chain_id: config.chain.chainId, first_hour_ts: 50 * DAY_SECONDS }],
      new Map([[`${config.chain.chainId}-${config.contractAddress}`, referenceHead]]),
      new Map([[config.chain.chainId, referenceHead]]),
    );

    expect(coverage.get(config.stablecoinId)).toMatchObject({
      startBlock: config.startBlock,
      lastSyncedBlock: referenceHead,
      lagBlocks: 0,
      has24hWindow: true,
      has30dWindow: true,
      has90dWindow: true,
      isPartial: false,
      status: "full",
    });
  });

  it("returns bootstrapping when lastSyncedBlock is very close to startBlock", () => {
    const config = pickSingleConfigCoin();
    // lastSyncedBlock only 50 blocks past startBlock.
    // No first-seen data and less than 24h of scanned range → bootstrapping.
    const lastSynced = config.startBlock + 50;
    const chainHead = config.startBlock + 1_000_000;
    const coverage = buildCoinCoverageMap(
      200 * DAY_SECONDS,
      [], // no first-seen rows for this coin
      new Map([[`${config.chain.chainId}-${config.contractAddress}`, lastSynced]]),
      new Map([[config.chain.chainId, chainHead]]),
    );

    expect(coverage.get(config.stablecoinId)).toMatchObject({
      status: "bootstrapping",
      isPartial: true,
      has24hWindow: false,
    });
  });

  it("keeps fully scanned quiet XAUT coverage mature after retained event rows expire", () => {
    const config = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "xaut-tether");
    expect(config).toBeDefined();

    const chainHead = 25_631_350;
    const coverage = buildCoinCoverageMap(
      1_785_243_764,
      [], // XAUT's last issuance event is older than hourly retention.
      new Map([[`${config!.chain.chainId}-${config!.contractAddress}`, chainHead - 5]]),
      new Map([[config!.chain.chainId, chainHead]]),
    );

    expect(coverage.get(config!.stablecoinId)).toMatchObject({
      historyStartAt: null,
      has24hWindow: true,
      has30dWindow: true,
      has90dWindow: true,
      lagBlocks: 5,
      isPartial: false,
      status: "full",
    });
  });

  it("uses a quiet scanned range to distinguish partial history from bootstrapping", () => {
    const config = pickSingleConfigCoin();
    const tenDaysOfBlocks = Math.ceil((10 * DAY_SECONDS) / 12);
    const chainHead = config.startBlock + tenDaysOfBlocks;
    const coverage = buildCoinCoverageMap(
      200 * DAY_SECONDS,
      [],
      new Map([[`${config.chain.chainId}-${config.contractAddress}`, chainHead]]),
      new Map([[config.chain.chainId, chainHead]]),
    );

    expect(coverage.get(config.stablecoinId)).toMatchObject({
      historyStartAt: null,
      has24hWindow: true,
      has30dWindow: false,
      has90dWindow: false,
      isPartial: true,
      status: "partial-history",
    });
  });

  it("returns lagging when lastSyncedBlock is beyond the cadence-derived chain threshold", () => {
    const config = pickSingleConfigCoin();
    const chainHead = config.startBlock + 1_000_000;
    // Ethereum threshold is 60 minutes of expected blocks: 3,600 / 12 = 300.
    const lastSynced = chainHead - 301;
    const coverage = buildCoinCoverageMap(
      200 * DAY_SECONDS,
      [{ stablecoin_id: config.stablecoinId, chain_id: config.chain.chainId, first_hour_ts: 50 * DAY_SECONDS }],
      new Map([[`${config.chain.chainId}-${config.contractAddress}`, lastSynced]]),
      new Map([[config.chain.chainId, chainHead]]),
    );

    expect(coverage.get(config.stablecoinId)).toMatchObject({
      status: "lagging",
      isPartial: true,
      lagBlocks: 301,
    });
  });

  it("returns unknown for established coverage when chain-head metadata is missing", () => {
    const config = pickSingleConfigCoin();
    const referenceHead = config.startBlock + 1_000_000;
    const coverage = buildCoinCoverageMap(
      200 * DAY_SECONDS,
      [{ stablecoin_id: config.stablecoinId, chain_id: config.chain.chainId, first_hour_ts: 50 * DAY_SECONDS }],
      new Map([[`${config.chain.chainId}-${config.contractAddress}`, referenceHead]]),
      new Map(),
    );

    expect(coverage.get(config.stablecoinId)).toMatchObject({
      status: "unknown",
      isPartial: true,
      lagBlocks: null,
      has30dWindow: true,
    });
  });

  it("returns partial-history when coin is tracked for < 30 days", () => {
    const config = pickSingleConfigCoin();
    const nowSec = 100 * DAY_SECONDS;
    // first_hour_ts 10 days ago → has 24h window but NOT 30d window
    const firstHourTs = nowSec - 10 * DAY_SECONDS;
    const referenceHead = config.startBlock + Math.ceil((10 * DAY_SECONDS) / 12);
    const coverage = buildCoinCoverageMap(
      nowSec,
      [{ stablecoin_id: config.stablecoinId, chain_id: config.chain.chainId, first_hour_ts: firstHourTs }],
      new Map([[`${config.chain.chainId}-${config.contractAddress}`, referenceHead]]),
      new Map([[config.chain.chainId, referenceHead]]),
    );

    expect(coverage.get(config.stablecoinId)).toMatchObject({
      status: "partial-history",
      isPartial: true,
      has24hWindow: true,
      has30dWindow: false,
    });
  });

  // Note: no MINT_BURN_CONFIGS entry has `enabled: false` today, so testing
  // the "disabled" status would require mocking the module import. Skipped
  // to avoid brittle coupling; the status branch is trivially readable.
});
