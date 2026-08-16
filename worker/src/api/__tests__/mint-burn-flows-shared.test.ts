import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  buildBaselineMap,
  buildCoinCoverageMap,
  cachedFlowFallbackResponse,
  ETHEREUM_CHAIN_ID,
  readMintBurnCronSnapshot,
  selectLargestEvents,
} from "../../lib/mint-burn-flows-service";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { FLOW_CACHE_PREFIX, readCachedFlow } from "../mint-burn-flows-shared";

describe("legacy mint/burn shared compatibility", () => {
  it("retains the allowlisted cache exports at their historical path", () => {
    expect(FLOW_CACHE_PREFIX).toBe("mint-burn-flows:v3");
    expect(typeof readCachedFlow).toBe("function");
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
});

describe("buildBaselineMap", () => {
  it("averages across tracked days, including days with no activity", () => {
    const nowSec = 4 * DAY_SECONDS + 1;
    const baseline = buildBaselineMap(
      nowSec,
      [
        { stablecoin_id: "usdt-tether", chain_id: ETHEREUM_CHAIN_ID, day_ts: 1 * DAY_SECONDS, daily_net: 30, daily_abs: 50 },
        { stablecoin_id: "usdt-tether", chain_id: ETHEREUM_CHAIN_ID, day_ts: 2 * DAY_SECONDS, daily_net: -15, daily_abs: 25 },
      ],
      [
        { stablecoin_id: "usdt-tether", chain_id: ETHEREUM_CHAIN_ID, first_hour_ts: 1 * DAY_SECONDS + 3600 },
      ],
    );

    expect(baseline.get("usdt-tether")).toEqual({
      avgNet: 5,
      avgAbs: 25,
      dataDays: 3,
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
        { stablecoin_id: "usdc-circle", chain_id: "ethereum", day_ts: 1 * DAY_SECONDS, daily_net: 100, daily_abs: 200 },
        { stablecoin_id: "usdc-circle", chain_id: "arbitrum", day_ts: 1 * DAY_SECONDS, daily_net: -40, daily_abs: 60 },
        { stablecoin_id: "usdc-circle", chain_id: "ethereum", day_ts: 2 * DAY_SECONDS, daily_net: 20, daily_abs: 30 },
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
    });
  });

  it("produces no entry when coin is first seen today (firstDayTs > baselineEndDayTs)", () => {
    // nowSec is within day 5 → baselineEndDayTs = day 4
    // first_hour_ts is within day 5 → firstDayTs = day 5 > day 4 → skipped
    const nowSec = 5 * DAY_SECONDS + 100;
    const baseline = buildBaselineMap(
      nowSec,
      [
        { stablecoin_id: "new-coin", chain_id: ETHEREUM_CHAIN_ID, day_ts: 5 * DAY_SECONDS, daily_net: 10, daily_abs: 10 },
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
        { stablecoin_id: "old-coin", chain_id: ETHEREUM_CHAIN_ID, day_ts: 1 * DAY_SECONDS, daily_net: 300, daily_abs: 300 },
      ],
      [
        { stablecoin_id: "old-coin", chain_id: ETHEREUM_CHAIN_ID, first_hour_ts: 1 * DAY_SECONDS },
      ],
    );

    expect(baseline.get("old-coin")).toEqual({
      avgNet: 10,
      avgAbs: 10,
      dataDays: 30,
    });
  });

  it("sets dataDays to actual tracked days when coin has fewer than 30 days", () => {
    // firstDayTs = day 10, baselineEndDayTs = day 20 → trackedDays = 11, dataDays = 11
    const nowSec = 21 * DAY_SECONDS + 1;
    const baseline = buildBaselineMap(
      nowSec,
      [
        { stablecoin_id: "young-coin", chain_id: ETHEREUM_CHAIN_ID, day_ts: 15 * DAY_SECONDS, daily_net: 55, daily_abs: 55 },
      ],
      [
        { stablecoin_id: "young-coin", chain_id: ETHEREUM_CHAIN_ID, first_hour_ts: 10 * DAY_SECONDS },
      ],
    );

    expect(baseline.get("young-coin")).toEqual({
      avgNet: 5,
      avgAbs: 5,
      dataDays: 11,
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
