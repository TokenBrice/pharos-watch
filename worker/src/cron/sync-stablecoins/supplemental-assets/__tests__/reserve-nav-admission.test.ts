import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";
import { BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import {
  JLTXX_ETHEREUM_CONTRACT, JLTXX_SOLANA_MINT, JLTXX_SOLANA_TOKEN_PROGRAM,
  type PinnedNativeShareObservation,
} from "@shared/types/reserve-nav-supply";
import type * as FetchRetry from "../../../../lib/fetch-retry";
import type * as OnchainSupply from "../onchain-supply";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { ReserveNavSnapshotRow } from "../../../../lib/reserve-nav-price";

const nowSec = () => Math.floor(Date.now() / 1000);
const supply = vi.fn();
const pinnedObservation = vi.fn<() => Promise<PinnedNativeShareObservation | null | undefined>>();
vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({ stablecoins: [{
  id: "jltxx-jpmorgan", name: "JPMorgan OnChain Liquidity-Token Money Market Fund", symbol: "JLTXX",
  geckoId: "jpmorgan-onchain-liquidity-token-money-market-fund", detailProvider: "coingecko",
  flags: { backing: "rwa-backed", governance: "centralized", pegCurrency: "USD", navToken: true, yieldBearing: true, rwa: true },
  contracts: [{ chain: "ethereum", address: "0x09864f52b035ae22ee739dfa5c748fa080d07bd8", decimals: 2 }],
  liveReservesConfig: { adapter: "jpmorgan-nav", version: 1, semantics: "single-asset", inputs: { primary: { kind: "http-html", url: "https://am.jpmorgan.com" } } },
}] }));
vi.mock("../../../../lib/fetch-retry", async (orig) => ({
  ...(await orig<typeof FetchRetry>()),
  fetchTextWithRetry: async () => ({ response: new Response('{"coins":{}}'), body: '{"coins":{}}' }),
}));
vi.mock("../../../reserve-adapters/helpers", () => ({ probeTrackedTokenSupply: (...args: unknown[]) => supply(...args) }));
vi.mock("../../../../lib/authoritative-price-sources", () => ({
  getFreshSingleSourceNavParentId: () => null, resolveVaultNavSupplyPrice: vi.fn().mockResolvedValue(null),
}));
vi.mock("../onchain-supply", async (orig) => ({
  ...(await orig<typeof OnchainSupply>()),
  fetchPinnedNativeShares: async () => {
    const custom = await pinnedObservation();
    if (custom !== undefined) return custom;
    const raw = await supply();
    if (raw == null || raw <= 0n) return null;
    const observedAt = nowSec();
    return {
      rawShares: raw.toString(), decimals: 2 as const, observedAt,
      legs: [{ chain: "ethereum" as const, contractAddress: JLTXX_ETHEREUM_CONTRACT, rawShares: raw.toString(), decimals: 2 as const, blockNumber: 100, blockHash: `0x${"a".repeat(64)}`, observedAt }],
    };
  },
}));

import { fetchFiatCoinGeckoTokens } from "../fiat-cg";
import * as structuredLog from "../../../../lib/structured-log";

const withheldLog = vi.spyOn(structuredLog, "logWorkerEvent");
const run = (db: D1Database, cg: Parameters<typeof fetchFiatCoinGeckoTokens>[0] = {}) =>
  fetchFiatCoinGeckoTokens(cg, undefined, undefined, undefined, db);
const expectWithheld = (metadata: Record<string, unknown>, event?: string) =>
  expect(withheldLog).toHaveBeenCalledWith(expect.objectContaining({
    ...(event ? { event } : {}), metadata: expect.objectContaining(metadata),
  }));

function snapshotDb(metadata: unknown, source = "jpmorgan-nav", overrides: Partial<ReserveNavSnapshotRow> = {}): D1Database {
  const now = nowSec();
  const fp = computeLiveReserveConfigFingerprint(ACTIVE_STABLECOINS[0].liveReservesConfig!);
  const row: ReserveNavSnapshotRow = {
    source, fetched_at: now, metadata: JSON.stringify(metadata), config_fingerprint: fp, state_config_fingerprint: fp,
    attempt_id: "success", last_success_attempt_id: "success", last_success_at: now, last_attempt_id: "success", pending_attempt_id: null,
    ...overrides,
  };
  return mockD1([
    { match: "FROM reserve_composition c", rows: [], first: { ...row } },
    { match: "cache", rows: [], first: null, allowUnused: true },
  ], { assertMatchesUsed: true });
}

function classSnapshot(classAssetsUsd: number, sourceTimestamp = Math.floor(nowSec() / 86400) * 86400) {
  return {
    navPerToken: 1, sourceTimestamp, freshnessMode: "verified",
    details: {
      cusip: "46655R119", shareClassNumber: "4397", ticker: "JLTXX", classAssetsUsd,
      supplyAdmissionReview: {
        maxNavSupplySkewSec: 432000, reviewedAt: "2026-10-01",
        evidenceRef: "https://example.com/test-only-reviewed-temporal-policy",
        perimeterRef: "https://example.com/test-only-native-class-perimeter",
      },
      dealingDate: new Date(sourceTimestamp * 1000).toISOString().slice(0, 10),
    },
  };
}

describe("NAV telemetry supply admission without a previous cache row", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-11-24T11:54:00.999Z");
    supply.mockReset().mockResolvedValue(62_671_284_229n);
    pinnedObservation.mockReset().mockResolvedValue(undefined);
    withheldLog.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("values two-decimal native shares at observed NAV, without fabricating a market quote", async () => {
    const val = 626_712_842.29 * 0.9973;
    expect(await run(snapshotDb({ ...classSnapshot(val), navPerToken: 0.9973 }))).toEqual([expect.objectContaining({
      id: "jltxx-jpmorgan", price: null, supplySource: "onchain-total-supply",
      circulating: { peggedUSD: val }, chainCirculating: { Ethereum: { chainId: "ethereum", current: val } },
    })]);
  });

  it("withholds a funded missing native leg instead of publishing a partial class", async () => {
    supply.mockResolvedValue(60_000_000_000n);
    expect(await run(snapshotDb(classSnapshot(700_000_000)))).toEqual([]);
    expectWithheld({ rule: "R4", reason: "class-assets-supply-divergence" }, "reserve-nav-supply-withheld");
  });

  it("admits a rounded class total within the reviewed tolerance", async () => {
    supply.mockResolvedValue(60_000_000_000n);
    expect((await run(snapshotDb(classSnapshot(602_000_000))))[0]).toMatchObject({
      circulating: { peggedUSD: 600_000_000 }, supplySource: "onchain-total-supply",
    });
  });

  it("withholds missing class assets even when NAV is fresh", async () => {
    expect(await run(snapshotDb({ navPerToken: 1, sourceTimestamp: nowSec() }))).toEqual([]);
    expectWithheld({ rule: "R4", reason: "class-assets-unavailable" });
  });

  it("does not bypass native-share admission with a positive CoinGecko price and market cap", async () => {
    supply.mockResolvedValue(60_000_000_000n);
    const cg = { "jpmorgan-onchain-liquidity-token-money-market-fund": { usd: 1.2, usd_market_cap: 900_000_000, last_updated_at: nowSec() } };
    expect(await run(snapshotDb(classSnapshot(700_000_000)), cg)).toEqual([]);
    expect((await run(snapshotDb(classSnapshot(600_000_000)), cg))[0]).toMatchObject({ circulating: { peggedUSD: 720_000_000 }, price: 1.2 });
  });

  it.each([null, { navPerToken: 1 }, { navPerToken: 0, sourceTimestamp: 1 }])("withholds admission when NAV is unavailable (%s)", async (metadata) => {
    expect(await run(snapshotDb(metadata))).toEqual([]);
  });

  it("withholds stale issuer NAV even if a fresh fetch repeats it", async () => {
    const staleDate = Math.floor(nowSec() / 86400) * 86400 - BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC - 86400;
    expect(await run(snapshotDb(classSnapshot(626_712_842.29, staleDate)))).toEqual([]);
    expectWithheld({ reason: "class-assets-unavailable" });
  });

  it.each(["2026-11-24T11:54:00.999Z", "2026-11-24T23:30:00Z"])(
    "requires a reviewed source cadence and legal/native perimeter, not a default skew (%s)",
    async (iso) => {
      vi.setSystemTime(iso);
      const metadata = classSnapshot(626_712_842.29);
      const { supplyAdmissionReview: _review, ...details } = metadata.details;
      expect(await run(snapshotDb({ ...metadata, details }))).toEqual([]);
      expectWithheld({ reason: "native-class-temporal-review-unavailable" });
    },
  );

  it.each([
    { config_fingerprint: null }, { config_fingerprint: "b".repeat(64) },
    { last_success_attempt_id: "different" }, { last_attempt_id: "failed-latest" }, { pending_attempt_id: "pending" },
  ])("withholds issuer-class supply without current success and latest-attempt binding: %j", async (binding) => {
    expect(await run(snapshotDb(classSnapshot(626_712_842.29), "jpmorgan-nav", binding))).toEqual([]);
  });

  it("requires positive readable on-chain supply despite a valid NAV", async () => {
    supply.mockResolvedValue(null);
    expect(await run(snapshotDb(classSnapshot(626_712_842.29)))).toEqual([]);
  });

  it("emits per-chain USD chainCirculating and oldest supplyObservedAt for 2-leg observations", async () => {
    const mk2 = (et: number, st: number): PinnedNativeShareObservation => ({
      rawShares: "70000000000", decimals: 2, observedAt: Math.min(et, st),
      legs: [
        { chain: "ethereum", contractAddress: JLTXX_ETHEREUM_CONTRACT, rawShares: "5000000000", decimals: 2, blockNumber: 200, blockHash: `0x${"a".repeat(64)}`, observedAt: et },
        { chain: "solana", contractAddress: JLTXX_SOLANA_MINT, rawShares: "65000000000", decimals: 2, slot: 460_000_000, programOwner: JLTXX_SOLANA_TOKEN_PROGRAM, observedAt: st },
      ],
    });
    const ethT = nowSec() - 120; const solT = nowSec() - 300;
    pinnedObservation.mockResolvedValue(mk2(ethT, solT));
    expect(await run(snapshotDb({ ...classSnapshot(700_000_000 * 0.9973), navPerToken: 0.9973 }))).toEqual([expect.objectContaining({
      id: "jltxx-jpmorgan", price: null, supplySource: "onchain-total-supply", supplyObservedAt: solT,
      circulating: { peggedUSD: 700_000_000 * 0.9973 },
      chainCirculating: { Ethereum: { chainId: "ethereum", current: 50_000_000 * 0.9973 }, Solana: { chainId: "solana", current: 650_000_000 * 0.9973 } },
    })]);

    for (const ms of [50, 2_000]) {
      vi.setSystemTime("2026-11-24T11:54:00.999Z");
      const pre = nowSec();
      pinnedObservation.mockImplementation(async () => { vi.setSystemTime(Date.now() + ms); const t = nowSec(); expect(t).toBeGreaterThan(pre); return mk2(t, t); });
      expect(await run(snapshotDb(classSnapshot(700_000_000)))).toHaveLength(1);
    }

    vi.setSystemTime("2026-11-24T11:54:00.000Z");
    const edgeFetch = nowSec() - 172_800;
    pinnedObservation.mockImplementation(async () => { vi.setSystemTime(Date.now() + 2_000); const t = nowSec(); return mk2(t, t); });
    expect(await run(snapshotDb(classSnapshot(700_000_000), "jpmorgan-nav", { fetched_at: edgeFetch, last_success_at: edgeFetch }))).toEqual([]);
    expectWithheld({ reason: "class-assets-unavailable" });
  });
});
