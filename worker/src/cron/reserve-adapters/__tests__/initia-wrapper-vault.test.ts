import { describe, expect, it } from "vitest";
import { runAdapter, type AdapterNetwork, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const BASE_URL = "https://rest.initia.xyz";
const VIEW_URL = `${BASE_URL}/initia/move/v1/view/json`;
const IUSD_DENOM = "move/6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e";
const IUSD_METADATA = "0x6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e";
const VAULT_OWNER = "0xfd6a07594842ac5d7501ff55243aff06e4f991f320828be05a4590970145e90a";
const AUSD0_METADATA = "0x8078cf9fee50e15069402e9d1d9db70b28fc0d5197d79e8a2b41e2ade432efef";
const MOVE_METADATA_TYPE = "0x1::fungible_asset::Metadata";
const MOVE_OBJECT_CORE_TYPE = "0x1::object::ObjectCore";
const IUSD_SUPPLY = "2519552759503";
const SUPPLY_URL = `${BASE_URL}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(IUSD_DENOM)}`;
const IUSD_CORE_URL = `${BASE_URL}/initia/move/v1/accounts/${IUSD_METADATA}/resources/by_struct_tag?struct_tag=${encodeURIComponent(MOVE_OBJECT_CORE_TYPE)}`;
const AUSD0_RESOURCE_URL = `${BASE_URL}/initia/move/v1/accounts/${AUSD0_METADATA}/resources/by_struct_tag?struct_tag=${encodeURIComponent(MOVE_METADATA_TYPE)}`;

function resource(address: string, structTag: string, data: Record<string, unknown>) {
  return {
    resource: {
      address,
      struct_tag: structTag,
      move_resource: JSON.stringify({ type: structTag, data }),
    },
  };
}


function initiaNetwork(
  vaultBalance = IUSD_SUPPLY,
  ausd0Metadata: Record<string, unknown> = {
    name: "AUSD0",
    symbol: "AUSD0",
    decimals: 6,
    project_uri: "https://www.agora.finance",
  },
  supply = IUSD_SUPPLY,
  owner = VAULT_OWNER,
): AdapterNetworkSpec {
  return {
    json: {
      [VIEW_URL]: { data: JSON.stringify(vaultBalance), events: [], gas_used: "7553" },
      [SUPPLY_URL]: { amount: { denom: IUSD_DENOM, amount: supply } },
      [IUSD_CORE_URL]: resource(IUSD_METADATA, MOVE_OBJECT_CORE_TYPE, { owner }),
      [AUSD0_RESOURCE_URL]: resource(AUSD0_METADATA, MOVE_METADATA_TYPE, ausd0Metadata),
    },
  };
}

function runInitia(network: AdapterNetworkSpec | AdapterNetwork = initiaNetwork()) {
  return runAdapter("initia-wrapper-vault", "iusd-initia", {
    network,
    nowSec: 1_800_000_000,
  });
}

describe("fetchInitiaWrapperVaultReserves", () => {
  it("publishes one raw unit of underbacking as degraded", async () => {
    const { result } = await runInitia(initiaNetwork((BigInt(IUSD_SUPPLY) - 1n).toString()));
    expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }));
  });

  it.each([4_999_999n, 5_000_000n])("preserves a tolerated %s raw-unit surplus", async (surplus) => {
    const balance = BigInt(IUSD_SUPPLY) + surplus;
    const { result } = await runInitia(initiaNetwork(balance.toString()));
    expect(result.metadata?.collateralizationRatio).toBe(Number(balance) / 2519552759503);
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "reserve-overcollateralized-dust", effect: "info" }),
    ]);
  });

  it("publishes a six-AUSD0 surplus without degrading", async () => {
    const { result } = await runInitia(initiaNetwork((BigInt(IUSD_SUPPLY) + 6_000_000n).toString()));
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings?.every((warning) => warning.effect === "info")).toBe(true);
  });

  it.each([["0", IUSD_SUPPLY], [IUSD_SUPPLY, "0"]])("publishes observed balance %s and supply %s", async (balance, supply) => {
    const { result } = await runInitia(initiaNetwork(balance, undefined, supply));
    expect(result.metadata?.collateralizationRatio).toBe(supply === "0" ? undefined : 0);
    expect(result.warnings).toContainEqual(expect.objectContaining({ effect: "degraded" }));
  });

  it("rejects malformed balance data", async () => {
    await expect(runInitia(initiaNetwork("not-an-amount"))).rejects.toThrow();
  });

  it("reads the recorded Initia responses and emits one 100% parent slice", async () => {
    const { result, network } = await runInitia();

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
        vaultBalanceRaw: IUSD_SUPPLY,
        iusdSupplyRaw: IUSD_SUPPLY,
        ausd0MetadataAddress: AUSD0_METADATA,
      },
    });
    expect(network.requests).toHaveLength(4);
  });

  it("fails closed when the iUSD ObjectCore is no longer owned by the vault", async () => {
    const wrongOwner = "0x1111111111111111111111111111111111111111111111111111111111111111";
    await expect(runInitia(initiaNetwork(IUSD_SUPPLY, undefined, IUSD_SUPPLY, wrongOwner)))
      .rejects.toThrow("iUSD metadata owner mismatch");
  });

  it("fails closed when AUSD0 metadata has the wrong symbol", async () => {
    await expect(runInitia(initiaNetwork(IUSD_SUPPLY, {
      name: "AUSD0",
      symbol: "NOT-AUSD0",
      decimals: 6,
      project_uri: "https://www.agora.finance",
    }))).rejects.toThrow("AUSD0 metadata symbol/name mismatch");
  });

  it("fails closed when AUSD0 metadata has the wrong project_uri", async () => {
    await expect(runInitia(initiaNetwork(IUSD_SUPPLY, {
      name: "AUSD0",
      symbol: "AUSD0",
      decimals: 6,
      project_uri: "https://example.invalid",
    }))).rejects.toThrow("AUSD0 metadata project_uri mismatch");
  });
});
