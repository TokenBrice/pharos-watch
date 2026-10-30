import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../../../lib/live-reserves/store-shared";
import {
  evaluateAdapterSnapshotAdmission,
  expectWarningEffect,
  expectWarnings,
  runAdapter,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";

const BASE_URL = "https://rest.initia.xyz";
const ALT_URL = "https://initia-alt.example";
const NOW = 1_800_000_000;
const CHAIN_ID = "interwoven-1";
const BLOCK_TIME_SEC = NOW - 5;
const START_HEIGHT = 21_500_000;
const END_HEIGHT = START_HEIGHT + 1;
const IUSD_DENOM = "move/6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e";
const IUSD_METADATA = "0x6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e";
const VAULT_OWNER = "0xfd6a07594842ac5d7501ff55243aff06e4f991f320828be05a4590970145e90a";
const AUSD0_METADATA = "0x8078cf9fee50e15069402e9d1d9db70b28fc0d5197d79e8a2b41e2ade432efef";
const WRONG_OWNER = "0x1111111111111111111111111111111111111111111111111111111111111111";
const MOVE_METADATA_TYPE = "0x1::fungible_asset::Metadata";
const MOVE_OBJECT_CORE_TYPE = "0x1::object::ObjectCore";
const IUSD_SUPPLY = "2519552759503";
const RETRY_SUPPLY = "2519553759503";
const REVIEWED_TRANSPORT = { lcdUrls: [BASE_URL, ALT_URL], chainId: CHAIN_ID };
const DEFAULT_AUSD0_METADATA = {
  name: "AUSD0",
  symbol: "AUSD0",
  decimals: 6,
  project_uri: "https://www.agora.finance",
};

interface ProviderFixture {
  balance?: string;
  supply?: string;
  chainId?: string;
  owner?: string;
  ausd0Metadata?: Record<string, unknown>;
  /** Heights answered by successive `blocks/latest` reads. */
  blockHeights?: number[];
  blockTimeSec?: number;
  /** Route the first read (node info) to HTTP 502, as an unreachable provider. */
  transportFailure?: boolean;
}

function resource(address: string, structTag: string, data: Record<string, unknown>) {
  return {
    resource: {
      address,
      struct_tag: structTag,
      move_resource: JSON.stringify({ type: structTag, data }),
    },
  };
}

function blockResponse(height: number, timeSec: number) {
  return {
    block: {
      header: {
        chain_id: CHAIN_ID,
        height: String(height),
        time: new Date(timeSec * 1_000).toISOString(),
      },
    },
  };
}

function providerRoutes(baseUrl: string, fixture: ProviderFixture = {}): Record<string, unknown> {
  const heights = fixture.blockHeights ?? [START_HEIGHT, END_HEIGHT];
  const blockTimeSec = fixture.blockTimeSec ?? BLOCK_TIME_SEC;
  let blockReads = 0;
  const routes: Record<string, unknown> = {
    [`${baseUrl}/cosmos/base/tendermint/v1beta1/node_info`]: {
      default_node_info: { network: fixture.chainId ?? CHAIN_ID },
    },
    [`${baseUrl}/cosmos/base/tendermint/v1beta1/blocks/latest`]: () => {
      const height = heights[Math.min(blockReads, heights.length - 1)]!;
      blockReads += 1;
      return blockResponse(height, blockTimeSec);
    },
    [`${baseUrl}/initia/move/v1/view/json`]: {
      data: JSON.stringify(fixture.balance ?? IUSD_SUPPLY),
      events: [],
      gas_used: "7553",
    },
    [`${baseUrl}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(IUSD_DENOM)}`]: {
      amount: { denom: IUSD_DENOM, amount: fixture.supply ?? IUSD_SUPPLY },
    },
    [`${baseUrl}/initia/move/v1/accounts/${IUSD_METADATA}/resources/by_struct_tag?struct_tag=${encodeURIComponent(MOVE_OBJECT_CORE_TYPE)}`]:
      resource(IUSD_METADATA, MOVE_OBJECT_CORE_TYPE, { owner: fixture.owner ?? VAULT_OWNER }),
    [`${baseUrl}/initia/move/v1/accounts/${AUSD0_METADATA}/resources/by_struct_tag?struct_tag=${encodeURIComponent(MOVE_METADATA_TYPE)}`]:
      resource(AUSD0_METADATA, MOVE_METADATA_TYPE, fixture.ausd0Metadata ?? DEFAULT_AUSD0_METADATA),
  };
  if (fixture.transportFailure) {
    routes[`${baseUrl}/cosmos/base/tendermint/v1beta1/node_info`] = { status: 502, body: "bad gateway" };
  }
  return routes;
}

function singleProvider(fixture: ProviderFixture = {}): AdapterNetworkSpec {
  return { json: providerRoutes(BASE_URL, fixture) };
}

function twoProviders(
  primary: ProviderFixture = {},
  alt: ProviderFixture = {},
): AdapterNetworkSpec {
  return { json: { ...providerRoutes(BASE_URL, primary), ...providerRoutes(ALT_URL, alt) } };
}

function runInitia(network: AdapterNetworkSpec, params?: Record<string, unknown>) {
  return runAdapter("initia-wrapper-vault", "iusd-initia", {
    network,
    nowSec: NOW,
    ...(params === undefined ? {} : { params }),
  });
}

describe("fetchInitiaWrapperVaultReserves", () => {
  it("publishes one raw unit of underbacking as degraded", async () => {
    const { result } = await runInitia(singleProvider({ balance: (BigInt(IUSD_SUPPLY) - 1n).toString() }));
    expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(result.slices[0].pct).toBe(100);
    expectWarningEffect(result, "reserve-undercollateralized", "degraded");
  });

  it.each([4_999_999n, 5_000_000n])("preserves a tolerated %s raw-unit surplus", async (surplus) => {
    const balance = BigInt(IUSD_SUPPLY) + surplus;
    const { result } = await runInitia(singleProvider({ balance: balance.toString() }));
    expect(result.metadata?.collateralizationRatio).toBe(Number(balance) / 2519552759503);
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expectWarnings(result, ["reserve-overcollateralized-dust", "single-node-observation"]);
    expectWarningEffect(result, "reserve-overcollateralized-dust", "info");
  });

  it("publishes a six-AUSD0 surplus without degrading", async () => {
    const { result } = await runInitia(singleProvider({ balance: (BigInt(IUSD_SUPPLY) + 6_000_000n).toString() }));
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings?.every((warning) => warning.effect === "info")).toBe(true);
  });

  it.each([["0", IUSD_SUPPLY], [IUSD_SUPPLY, "0"]])("publishes observed balance %s and supply %s", async (balance, supply) => {
    const { result } = await runInitia(singleProvider({ balance, supply }));
    expect(result.metadata?.collateralizationRatio).toBe(supply === "0" ? undefined : 0);
    expect(result.warnings).toContainEqual(expect.objectContaining({ effect: "degraded" }));
  });

  it("rejects malformed balance data", async () => {
    await expect(runInitia(singleProvider({ balance: "not-an-amount" }))).rejects.toThrow();
  });

  it("reads the recorded Initia responses and emits one 100% parent slice with its block clock", async () => {
    const { result } = await runInitia(singleProvider());

    expect(result.slices).toEqual([
      {
        sourceKey: "initia-wrapper-vault:ausd",
        name: "Agora AUSD bridged via LayerZero (Initia AUSD0)",
        pct: 100,
        risk: "low",
        coinId: "ausd-agora",
        depType: "wrapper",
      },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      supplyTokens: 2_519_552.759503,
      totalReserveQuantity: 2_519_552.759503,
      collateralizationRatio: 1,
      details: {
        proofKind: "initia-wrapper-vault-balance-vs-bank-supply",
        chainId: CHAIN_ID,
        lcdProvider: BASE_URL,
        lcdProviders: [BASE_URL],
        corroboratingLcdProviders: [],
        providerTransportFailures: [],
        batchStartHeight: START_HEIGHT,
        latestStateHeight: END_HEIGHT,
        latestStateBlockTimeSec: BLOCK_TIME_SEC,
        latestStateBlockTime: new Date(BLOCK_TIME_SEC * 1_000).toISOString(),
        heightDriftBlocks: 1,
        iusdSupplyAgreement: { observedEndpoints: 1, agreement: "unavailable" },
        vaultBalanceRaw: IUSD_SUPPLY,
        iusdSupplyRaw: IUSD_SUPPLY,
        ausd0MetadataAddress: AUSD0_METADATA,
      },
    });
    expectWarningEffect(result, "single-node-observation", "info");
  });

  it("fails closed when the iUSD ObjectCore is no longer owned by the vault", async () => {
    await expect(runInitia(singleProvider({ owner: WRONG_OWNER })))
      .rejects.toThrow("iUSD metadata owner mismatch");
  });

  it("fails closed when AUSD0 metadata has the wrong symbol", async () => {
    await expect(runInitia(singleProvider({
      ausd0Metadata: { ...DEFAULT_AUSD0_METADATA, symbol: "NOT-AUSD0" },
    }))).rejects.toThrow("AUSD0 metadata symbol/name mismatch");
  });

  it("fails closed when AUSD0 metadata has the wrong project_uri", async () => {
    await expect(runInitia(singleProvider({
      ausd0Metadata: { ...DEFAULT_AUSD0_METADATA, project_uri: "https://example.invalid" },
    }))).rejects.toThrow("AUSD0 metadata project_uri mismatch");
  });

  it("fails over a transport failure to the next reviewed provider", async () => {
    const { result } = await runInitia(twoProviders({ transportFailure: true }), REVIEWED_TRANSPORT);
    expect(result.metadata?.collateralizationRatio).toBe(1);
    expect(result.metadata?.supplyTokens).toBe(2_519_552.759503);
    expect(result.metadata?.details).toMatchObject({
      lcdProvider: ALT_URL,
      lcdProviders: [BASE_URL, ALT_URL],
      corroboratingLcdProviders: [],
      providerTransportFailures: [{ provider: BASE_URL, reason: "http-502" }],
      latestStateHeight: END_HEIGHT,
      latestStateBlockTimeSec: BLOCK_TIME_SEC,
      iusdSupplyAgreement: { observedEndpoints: 1, agreement: "unavailable" },
    });
    expectWarningEffect(result, "single-node-observation", "info");
  });

  it("fails the snapshot when reviewed providers disagree on iusdSupply", async () => {
    const network = twoProviders({}, { supply: (BigInt(IUSD_SUPPLY) + 1n).toString() });
    await expect(runInitia(network, REVIEWED_TRANSPORT)).rejects.toThrow(/disagree on iusdSupply/);
  });

  it("publishes exact multi-provider agreement with the agreeing providers and block clock", async () => {
    const run = await runInitia(twoProviders(), REVIEWED_TRANSPORT);
    const { result } = run;
    expect(evaluateAdapterSnapshotAdmission(run, NOW).eligible).toBe(true);
    expect(result.metadata?.collateralizationRatio).toBe(1);
    expect(result.metadata?.details).toMatchObject({
      lcdProvider: BASE_URL,
      corroboratingLcdProviders: [ALT_URL],
      providerTransportFailures: [],
      latestStateHeight: END_HEIGHT,
      latestStateBlockTimeSec: BLOCK_TIME_SEC,
      iusdSupplyAgreement: { observedEndpoints: 2, agreement: "exact" },
    });
    expect(result.warnings?.some((warning) => warning.code === "single-node-observation") ?? false).toBe(false);
  });

  it.each([
    ["owner", { owner: WRONG_OWNER }, /iUSD metadata owner mismatch/],
    ["chain id", { chainId: "interwoven-test" }, /chain id does not match/],
  ] as const)("does not fail over a primary %s corroboration failure", async (_label, primary, pattern) => {
    await expect(runInitia(twoProviders(primary), REVIEWED_TRANSPORT)).rejects.toThrow(pattern);
  });

  it("retries a drifting batch once and publishes a degraded latest-state-height-drift", async () => {
    const { result } = await runInitia(singleProvider({ blockHeights: [100, 200, 300, 401] }));
    expect(result.metadata?.details).toMatchObject({
      heightDriftBlocks: 101,
      heightDriftRetried: true,
      batchStartHeight: 300,
      latestStateHeight: 401,
    });
    expectWarningEffect(result, "latest-state-height-drift", "degraded");
  });

  it("keeps a drift-free retry quiet", async () => {
    const { result } = await runInitia(singleProvider({ blockHeights: [100, 200, 300, 301] }));
    expect(result.metadata?.details).toMatchObject({
      heightDriftBlocks: 1,
      heightDriftRetried: true,
      batchStartHeight: 300,
      latestStateHeight: 301,
    });
    expect(result.warnings?.some((warning) => warning.code === "latest-state-height-drift") ?? false).toBe(false);
  });

  it("re-reads the batch instead of replaying the request cache on a drift retry", async () => {
    const routes = providerRoutes(BASE_URL, { blockHeights: [100, 200, 300, 301] });
    let supplyReads = 0;
    routes[`${BASE_URL}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(IUSD_DENOM)}`] = () => {
      supplyReads += 1;
      return { amount: { denom: IUSD_DENOM, amount: supplyReads === 1 ? IUSD_SUPPLY : RETRY_SUPPLY } };
    };
    const { result } = await runInitia({ json: routes });
    expect(result.metadata?.details?.iusdSupplyRaw).toBe(RETRY_SUPPLY);
  });

  it("fails closed when the latest block clock falls outside the latest-state budget", async () => {
    const stale = NOW - LIVE_RESERVE_FRESHNESS_SEC - 1;
    await expect(runInitia(singleProvider({ blockTimeSec: stale })))
      .rejects.toThrow(/latest-state budget/);
  });

  it.each([
    [
      "more than three providers",
      { lcdUrls: [BASE_URL, ALT_URL, "https://third.example", "https://fourth.example"], chainId: CHAIN_ID },
      /1-3 reviewed LCD endpoints/,
    ],
    ["a duplicate provider", { lcdUrls: [BASE_URL, BASE_URL], chainId: CHAIN_ID }, /duplicate endpoint/],
    ["a first provider that is not the primary input", { lcdUrls: [ALT_URL, BASE_URL], chainId: CHAIN_ID }, /lcdUrls\[0\] must equal/],
    ["a missing reviewed chain id", { lcdUrls: [BASE_URL, ALT_URL] }, /chainId is required/],
    ["an unreviewed chain id", { lcdUrls: [BASE_URL], chainId: "interwoven-test" }, /chainId must be the reviewed/],
    ["a non-https provider", { lcdUrls: ["http://rest.initia.xyz"], chainId: CHAIN_ID }, /must be an absolute https URL/],
  ] as const)("rejects a transport list with %s", async (_label, params, pattern) => {
    await expect(runInitia(singleProvider(), params)).rejects.toThrow(pattern);
  });
});
