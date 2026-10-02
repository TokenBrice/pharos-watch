import { describe, expect, it } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import babelFish from "@shared/data/stablecoins/coins/xusd-babelfish.json";
import usual from "@shared/data/stablecoins/coins/usd0-usual.json";
import { adaptBranchBalanceReserves, readBranchBalanceParams } from "../branch-balances";
import { runAdapter, type AdapterNetworkSpec, type AdapterRpcValue } from "./reserve-adapter.test-support";

const WAD = 10n ** 18n;
const NOW_SEC = Date.parse("2026-10-02T12:00:00Z") / 1000;
const fundedBAsset = "0xff4299bca0313c20a61dc5ed597739743bef3f6d";
const usd0Config = usual.liveReservesConfig as LiveReservesConfig;
const usd0Params = readBranchBalanceParams(usd0Config, "evm-branch-balances");

function addressArray(addresses: string[]): string {
  return `0x${[32n, BigInt(addresses.length), ...addresses.map(BigInt)]
    .map((word) => word.toString(16).padStart(64, "0")).join("")}`;
}

function usualNetwork(options: { failedBalance?: string; failedPrice?: string; registry?: string[] } = {}): AdapterNetworkSpec {
  const rpc: Record<string, AdapterRpcValue> = {
    "0x43882c864a406d55411b8c166bca604709fdf624:0x43069d46": addressArray(
      options.registry ?? usd0Params.branches.map((branch) => branch.token.address),
    ),
    "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5:totalSupply()": 100n * WAD,
  };
  for (const branch of usd0Params.branches) {
    rpc[`${branch.token.address}:balanceOf(address)`] = branch.token.address === options.failedBalance
      ? null
      : branch.coinId === "usdtb-ethena" ? 0n
        : (branch.unclassifiedSelfReferential ? 20n : 10n) * 10n ** BigInt(branch.token.decimals);
    rpc[`${branch.token.address}:decimals()`] = BigInt(branch.token.decimals);
    const priceData = `0x41976e09${branch.token.address.slice(2).toLowerCase().padStart(64, "0")}`;
    rpc[`0xb97e163ce6a8296f36112b042891cfe1e23c35bf:${priceData}`] = branch.token.address === options.failedPrice ? null : WAD;
  }
  return { rpc };
}

async function runUsual(network: AdapterNetworkSpec) {
  return runAdapter("evm-branch-balances", "usd0-usual", {
    config: usd0Config, network, nowSec: NOW_SEC,
  });
}

describe("branch reserve census and unavailable residual", () => {
  it("includes a newly funded verified BabelFish bAsset before normalizing the basket", async () => {
    const config = babelFish.liveReservesConfig as LiveReservesConfig;
    const params = readBranchBalanceParams(config, "evm-branch-balances");
    const rpc: Record<string, AdapterRpcValue> = {
      "0xb5999795be0ebb5bab23144aa5fd6a02d080299f:totalSupply()": 108n * WAD,
    };
    for (const branch of params.branches) {
      rpc[`${branch.token.address}:balanceOf(address)`] = (branch.token.address === fundedBAsset ? 99n : 1n) * WAD;
      rpc[`${branch.token.address}:decimals()`] = 18n;
    }
    const { result } = await runAdapter("evm-branch-balances", "xusd-babelfish", {
      config, nowSec: NOW_SEC,
      network: {
        rpc,
        block: { timestamp: NOW_SEC },
        json: {
          "https://coins.llama.fi/prices/current/rootstock:0xe700691da7b9851f2f35f8b8182c69c53ccad9db": {
            coins: { "rootstock:0xe700691da7b9851f2f35f8b8182c69c53ccad9db": { price: 1, timestamp: NOW_SEC, confidence: 0.99 } },
          },
        },
      },
    });
    // Nine $1 constituents round to 0.9% each; the largest $99 slice
    // absorbs the one-decimal rounding remainder: 100 - 9 * 0.9 = 91.9%.
    expect(result.slices.find((slice) => slice.sourceKey?.endsWith(fundedBAsset))?.pct).toBe(91.9);
    expect(result.metadata?.unknownExposurePct).toBe(0);
    expect(result.metadata?.collateralizationRatio).toBe(1);
  });

  it("withholds reserve weights rather than deriving missing collateral from liabilities", async () => {
    const failedBalance = usd0Params.branches.find((branch) => branch.coinId === "usyc-hashnote")!.token.address;
    const { result } = await runUsual(usualNetwork({ failedBalance }));
    expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.metadata?.valuationComplete).toBe(false);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "branch-reserve-book-partial", effect: "degraded" }));
  });

  it("keeps an unpriced constituent unavailable instead of deleting it from the denominator", async () => {
    const failedPrice = usd0Params.branches.find((branch) => branch.coinId === "ustbl-spiko")!.token.address;
    const { result } = await runUsual(usualNetwork({ failedPrice }));
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.slices.some((slice) => slice.coinId === "ustbl-spiko")).toBe(false);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
  });

  it.each(["extra", "replacement", "removed", "duplicate", "unreadable"])("rejects a %s on-chain registry rather than certifying configured rows", async (change) => {
    const registry = usd0Params.branches.map((branch) => branch.token.address);
    const unknown = "0x0000000000000000000000000000000000000001";
    if (change === "extra") registry.push(unknown);
    if (change === "replacement") registry[0] = unknown;
    if (change === "removed") registry.pop();
    if (change === "duplicate") registry[0] = registry[1];
    const network = usualNetwork({ registry });
    if (change === "unreadable") network.rpc!["0x43882c864a406d55411b8c166bca604709fdf624:0x43069d46"] = null;
    await expect(runUsual(network)).rejects.toThrow(/reserve registry/);
  });

  it("certifies a same-run holder registry without confusing vault identities with reserve tokens", async () => {
    const branch = usd0Params.branches[0];
    const config = { ...usd0Config, params: { ...usd0Config.params,
      branches: [branch], census: { ...usd0Params.census, identity: "holder" },
    } } as LiveReservesConfig;
    const accepted = await runAdapter("evm-branch-balances", "usd0-usual", {
      config, network: usualNetwork({ registry: [branch.holder] }), nowSec: NOW_SEC,
    });
    expect(accepted.result.metadata).toMatchObject({ censusComplete: true, unknownExposurePct: 0, collateralizationRatio: 0.1 });
    await expect(runAdapter("evm-branch-balances", "usd0-usual", {
      config, network: usualNetwork({ registry: [branch.token.address] }), nowSec: NOW_SEC,
    })).rejects.toThrow(/reserve registry drift/);
  });

  it("keeps observed zero USDtb distinct from USD0-denominated circular claims", async () => {
    const { result } = await runUsual(usualNetwork());
    expect(result.metadata?.censusComplete).toBe(true);
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.slices.some((slice) => slice.coinId === "ustbl-spiko")).toBe(false);
    expect(result.slices.some((slice) => slice.name === "U0R" || slice.name === "EVK Vault eUSD0-4")).toBe(false);
    const details = result.metadata?.details as {
      branchObservations: Array<{ name: string; balanceRaw: string | null }>;
      unavailableBranches: Array<{ name: string; reason: string }>;
      unclassifiedSelfReferentialBranches: string[];
    };
    expect(details.branchObservations.find((entry) => entry.name.startsWith("USDtb"))?.balanceRaw).toBe("0");
    expect(details.unavailableBranches).toEqual([]);
    expect(details.unclassifiedSelfReferentialBranches.sort()).toEqual(["EVK Vault eUSD0-4", "U0R"]);
  });

  it("preserves a partial book without a denominator as unknown, not a normalized known-only mix", () => {
    const branch = usd0Params.branches[0];
    const result = adaptBranchBalanceReserves({
      adapterKey: "evm-branch-balances", priceMap: new Map([[branch.name, 1]]),
      balances: [
        { branch, balanceRaw: 10n ** BigInt(branch.token.decimals) },
        { branch: usd0Params.branches[1], balanceRaw: null },
      ],
    });
    expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.metadata?.unknownExposureUnavailableReason).toBe("partial-book-without-residual-bound");
  });

  it.each([undefined, 20, 100, 1000])("never uses liabilities %s to bound a partial collateral book", (liabilityUsd) => {
    const branch = usd0Params.branches[0];
    const result = adaptBranchBalanceReserves({
      adapterKey: "evm-branch-balances", priceMap: new Map([[branch.name, 1]]),
      balances: [{ branch, balanceRaw: 40n * 10n ** BigInt(branch.token.decimals), observedDecimals: BigInt(branch.token.decimals) },
        { branch: usd0Params.branches[1], balanceRaw: null }],
      censusComplete: true, liabilityUsd,
    });
    expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.metadata?.details).toMatchObject({ knownReserveValueUsd: 40, residualUsd: null, contextualObservationsOnly: true });
  });

  it.each([
    ["2099-01-01", NOW_SEC, false],
    ["2026-10-02", NOW_SEC, false],
    ["2026-10-01", NOW_SEC, true],
    ["2025-10-02", NOW_SEC, false],
    ["2025-10-02", Date.parse("2025-10-02T00:00:00Z") / 1000 + V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec, true],
    ["2025-10-02", Date.parse("2025-10-02T00:00:00Z") / 1000 + V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec + 1, false],
  ] as const)("gates reviewed census %s at %s", async (reviewedAt, nowSec, admitted) => {
    const config = { ...usd0Config, params: { ...usd0Config.params,
      branches: [usd0Params.branches[0]], census: { kind: "reviewed-roster", reviewedAt, sourceUrls: ["https://example.com/census"] },
    } } as LiveReservesConfig;
    const { result } = await runAdapter("evm-branch-balances", "usd0-usual", { config, network: { ...usualNetwork(), block: { timestamp: nowSec } }, nowSec });
    expect(result.metadata?.censusComplete).toBe(admitted);
    expect(result.metadata?.collateralizationRatio).toBe(admitted ? 0.1 : undefined);
    expect(result.metadata?.unknownExposurePct).toBe(admitted ? 0 : undefined);
  });

  it("does not let an elapsed current review certify an observation pinned before that review", async () => {
    const config = { ...usd0Config, params: { ...usd0Config.params,
      branches: [usd0Params.branches[0]], census: { kind: "reviewed-roster", reviewedAt: "2026-10-01", sourceUrls: ["https://example.com/census"] },
    } } as LiveReservesConfig;
    const { result } = await runAdapter("evm-branch-balances", "usd0-usual", {
      config, network: { ...usualNetwork(), block: { timestamp: Date.parse("2026-10-01T12:00:00Z") / 1000 } }, nowSec: NOW_SEC,
    });
    expect(result.metadata?.censusComplete).toBe(false);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
  });

  it("does not claim zero unknown exposure from an uncertified configured roster", () => {
    const branch = usd0Params.branches[0];
    const result = adaptBranchBalanceReserves({
      adapterKey: "evm-branch-balances", priceMap: new Map([[branch.name, 1]]),
      balances: [{ branch, balanceRaw: 10n ** BigInt(branch.token.decimals) }],
    });
    expect(result.metadata?.censusComplete).toBe(false);
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(result.metadata?.unknownExposureUnavailableReason).toBe("configured-branches-not-certified-census");
  });

  it("rejects an unsupported census mode instead of silently dropping its completeness contract", () => {
    expect(() => readBranchBalanceParams({
      ...usd0Config, params: { ...usd0Config.params, census: { kind: "assumed-complete" } },
    }, "evm-branch-balances")).toThrow();
  });
});
