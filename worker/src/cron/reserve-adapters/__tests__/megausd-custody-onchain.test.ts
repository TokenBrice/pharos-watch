import { describe, expect, it } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeBalanceOfCallData } from "../../../lib/evm-selectors";
import {
  fetchMegausdCustodyOnchainReserves,
  MEGAUSD_CUSTODY_DISCOVERY_URL,
  MEGAUSD_CUSTODY_ROSTER_MAX_AGE_SEC,
  type MegausdCustodyOnchainParams,
} from "../megausd-custody-onchain";
import {
  expectWarningEffect,
  installAdapterNetwork,
  resolveAdapterCoin,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";

const NOW = Math.floor(Date.parse("2026-10-29T18:25:11.000Z") / 1000);
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDTB = "0xc139190f447e929f090edeb554d95abb8b18ac1c";
const ZERO_CUSTODIAN = "0x000000000000000000000000000000000000dead";

/**
 * RA-3b reviewed roster (`exec/notes/RA-3b-megausd-roster.md` §2–3): five
 * custodians × USDC/USDtb, all Ethereum. Amounts are the packet's exact
 * on-chain `balanceOf` raws at block 26300177 (2026-10-29T18:25:11Z), which
 * matched the issuer payload row-for-row. Production params arrive through the
 * shared declaration/coin config, not from this file.
 */
const CUSTODIANS = [
  "0xe0406bee6d58bcd7c1ca78191b6fde9ca060f6f2",
  "0x343c18b0f1710b65ce33a7ce720b5d540215d343",
  "0x01b3afebda3ed0e55fedb10dada5ef8dbe8f8d0c",
  "0x99f97f2822478f71e6ea8bd872e61df10ae19ccd",
  "0xf6a4347fe4f2c8d7228d3d53ab8e0d0cfc507ddc",
] as const;

const ROSTER = [
  ...CUSTODIANS.map((custodian) => ({ chain: "ethereum", token: USDC, custodian, assetKey: "usdc" })),
  ...CUSTODIANS.map((custodian) => ({ chain: "ethereum", token: USDTB, custodian, assetKey: "usdtb" })),
];

const USDC_RAW = [1_439_084_060_991n, 13_906_617_077_171n, 438_000_622n, 1_000_109_000n, 0n];
const USDTB_RAW = [
  1_607_822_777_000_000_000_000n,
  19_187_018_863_100_000_000_000n,
  121_000_000_000_000_000_000n,
  0n,
  0n,
];
const USDC_TOTAL = USDC_RAW.reduce((sum, raw) => sum + Number(raw) / 1e6, 0);
const USDTB_TOTAL = USDTB_RAW.reduce((sum, raw) => sum + Number(raw) / 1e18, 0);
const TOTAL = USDC_TOTAL + USDTB_TOTAL;

const BLOCK = {
  number: 26_300_177,
  timestamp: NOW,
  hash: "0x1b5fbdd505a18ba64354cec733c7bf147210f62d60b1b1dbd1e0b6220aa105fe",
};

const base = resolveAdapterCoin("megausd-custody-onchain", "usdm-mega");

function config(params: Record<string, unknown>): LiveReservesConfig {
  return {
    ...base.config,
    inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
    params,
  };
}

function params(overrides: Partial<MegausdCustodyOnchainParams> = {}): Record<string, unknown> {
  const value: MegausdCustodyOnchainParams = {
    rosterReviewedAt: "2026-10-29T18:25:11Z",
    roster: ROSTER,
    ...overrides,
  };
  return { rosterReviewedAt: value.rosterReviewedAt, roster: value.roster };
}

function rpcTable(): Record<string, AdapterRpcValue> {
  const rpc: Record<string, AdapterRpcValue> = {
    [`${USDC}:decimals()`]: 6,
    [`${USDTB}:decimals()`]: 18,
  };
  CUSTODIANS.forEach((custodian, index) => {
    rpc[`${USDC}:${encodeBalanceOfCallData(custodian)}`] = USDC_RAW[index]!;
    rpc[`${USDTB}:${encodeBalanceOfCallData(custodian)}`] = USDTB_RAW[index]!;
  });
  return rpc;
}

function disclosure(custodians: readonly string[] = CUSTODIANS) {
  return {
    backingAssets: {
      USDC: custodians.map((custodian) => ({ amount: 0, custodian })),
      USDm: custodians.map((custodian) => ({ amount: 0, custodian })),
      USDtb: custodians.map((custodian) => ({ amount: 0, custodian })),
    },
    lastUpdatedAt: "2026-10-29T18:19:11.000Z",
  };
}

function networkSpec(overrides: Partial<AdapterNetworkSpec> = {}): AdapterNetworkSpec {
  return {
    json: { [MEGAUSD_CUSTODY_DISCOVERY_URL]: disclosure() },
    rpc: rpcTable(),
    block: BLOCK,
    ...overrides,
  };
}

async function run(
  options: { network?: AdapterNetworkSpec; params?: Record<string, unknown>; nowSec?: number } = {},
) {
  const network = installAdapterNetwork(options.network ?? networkSpec());
  const result = await fetchMegausdCustodyOnchainReserves(
    base.coin,
    config(options.params ?? params()),
    new AbortController().signal,
    { chainRpcs: network.chainRpcs, nowSec: options.nowSec ?? NOW },
  );
  return { result, network };
}

describe("MegaUSD on-chain custody roster", () => {
  it("aggregates every custodian into the two unchanged reviewed keys", async () => {
    const { result } = await run();

    expect(result.slices).toEqual([
      {
        sourceKey: "megausd-custody:usdc",
        name: "USDC cash-equivalent reserves",
        pct: expect.closeTo((USDC_TOTAL / TOTAL) * 100, 10),
        risk: "low",
        coinId: "usdc-circle",
        depType: "collateral",
      },
      {
        sourceKey: "megausd-custody:usdtb",
        name: "USDtb cash-equivalent reserves",
        pct: expect.closeTo((USDTB_TOTAL / TOTAL) * 100, 10),
        risk: "low",
        coinId: "usdtb-ethena",
        depType: "collateral",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      sourceTimestamp: BLOCK.timestamp,
      freshnessMode: "verified",
      details: {
        chain: "ethereum",
        blockNumber: BLOCK.number,
        blockHash: BLOCK.hash,
        rosterReviewedAt: "2026-10-29T18:25:11Z",
        rosterDiscovery: "matched",
        rosterDiscoveryUrl: MEGAUSD_CUSTODY_DISCOVERY_URL,
      },
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(TOTAL, 6);
    expect(result.metadata?.details?.custodians).toHaveLength(10);
    expect(result.metadata?.details?.custodians).toContainEqual(
      expect.objectContaining({ assetKey: "usdc", custodian: CUSTODIANS[4], raw: "0" }),
    );
    expect(result.metadata?.details?.tokens).toEqual([
      { assetKey: "usdc", token: USDC, decimals: 6 },
      { assetKey: "usdtb", token: USDTB, decimals: 18 },
    ]);
  });

  it("fails the whole snapshot when one custodian balance is unreadable", async () => {
    const rpc = rpcTable();
    rpc[`${USDC}:${encodeBalanceOfCallData(CUSTODIANS[2]!)}`] = null;

    await expect(run({ network: networkSpec({ rpc }) })).rejects.toThrow(
      "observation failed: balance:usdc:",
    );
  });

  it("fails closed with custody-roster-unverified after 30 days without review", async () => {
    const stale = new Date((NOW - MEGAUSD_CUSTODY_ROSTER_MAX_AGE_SEC - 1) * 1000).toISOString();
    const network = installAdapterNetwork({});

    await expect(
      fetchMegausdCustodyOnchainReserves(
        base.coin,
        config(params({ rosterReviewedAt: stale })),
        new AbortController().signal,
        { chainRpcs: network.chainRpcs, nowSec: NOW },
      ),
    ).rejects.toThrow("custody-roster-unverified");
    expect(network.requests).toHaveLength(0);
  });

  it("publishes at exactly the 30-day review boundary", async () => {
    const boundary = new Date((NOW - MEGAUSD_CUSTODY_ROSTER_MAX_AGE_SEC) * 1000).toISOString();
    const { result } = await run({ params: params({ rosterReviewedAt: boundary }) });

    expect(result.slices.map((slice) => slice.sourceKey)).toEqual([
      "megausd-custody:usdc",
      "megausd-custody:usdtb",
    ]);
  });

  it("degrades with custody-roster-drift when the issuer discloses a different custodian set", async () => {
    const drifted = [ZERO_CUSTODIAN, ...CUSTODIANS.slice(1)];
    const { result } = await run({
      network: networkSpec({ json: { [MEGAUSD_CUSTODY_DISCOVERY_URL]: disclosure(drifted) } }),
    });

    expectWarningEffect(result, "custody-roster-drift", "degraded");
    expect(result.metadata?.details?.rosterDiscovery).toBe("drift");
    expect(String(result.metadata?.details?.rosterDrift)).toContain("undisclosed roster custodians");
    // Drift is an advisory on the roster identity; measured balances still publish.
    expect(result.slices[0]?.sourceKey).toBe("megausd-custody:usdc");
  });

  it("keeps the measured snapshot when the geo-gated issuer JSON is unavailable", async () => {
    const { result } = await run({ network: networkSpec({ json: {} }) });

    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.details?.rosterDiscovery).toBe("unavailable");
    expect(result.metadata?.details?.rosterDiscoveryReason).toBeTruthy();
    expect(result.slices).toHaveLength(2);
  });

  it("fails closed when every custodian reports a zero balance", async () => {
    const rpc = rpcTable();
    for (const custodian of CUSTODIANS) {
      rpc[`${USDC}:${encodeBalanceOfCallData(custodian)}`] = 0n;
      rpc[`${USDTB}:${encodeBalanceOfCallData(custodian)}`] = 0n;
    }

    await expect(run({ network: networkSpec({ rpc }) })).rejects.toThrow(
      "no positive custodian balances",
    );
  });
});
