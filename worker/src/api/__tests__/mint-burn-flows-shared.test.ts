import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import {
  buildBaselineMap,
  buildCoinCoverageMap,
  cachedFlowFallbackResponse,
  ETHEREUM_CHAIN_ID,
  readMintBurnCronSnapshot,
  selectLargestEvents,
} from "../mint-burn-flows-shared";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { DAY_SECONDS } from "@shared/lib/time-constants";

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
    });
  });
});

describe("buildBaselineMap", () => {
  it("averages across tracked days, including days with no activity", () => {
    const nowSec = 4 * DAY_SECONDS + 1;
    const baseline = buildBaselineMap(
      nowSec,
      [
        { stablecoin_id: "usdt-tether", day_ts: 1 * DAY_SECONDS, daily_net: 30, daily_abs: 50 },
        { stablecoin_id: "usdt-tether", day_ts: 2 * DAY_SECONDS, daily_net: -15, daily_abs: 25 },
      ],
      [
        { stablecoin_id: "usdt-tether", first_hour_ts: 1 * DAY_SECONDS + 3600 },
      ],
    );

    expect(baseline.get("usdt-tether")).toEqual({
      avgNet: 5,
      avgAbs: 25,
      dataDays: 3,
    });
  });
});

describe("buildCoinCoverageMap", () => {
  it("marks a well-synced long-history coin as full coverage", () => {
    const config = MINT_BURN_CONFIGS.find((entry) => entry.chain.chainId === ETHEREUM_CHAIN_ID);
    expect(config).toBeDefined();
    if (!config) return;

    const referenceHead = config.startBlock + 1_000_000;
    const coverage = buildCoinCoverageMap(
      200 * DAY_SECONDS,
      [{ stablecoin_id: config.stablecoinId, first_hour_ts: 50 * DAY_SECONDS }],
      new Map([[`${config.chain.chainId}-${config.contractAddress}`, referenceHead]]),
      referenceHead,
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
});
