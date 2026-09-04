import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../request", () => ({
  fetchJsonPostWithRetry: vi.fn(),
  fetchJsonWithRetry: vi.fn(),
}));

import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "../request";
import { fetchInitiaWrapperVaultReserves } from "../initia-wrapper-vault";

const BASE_URL = "https://rest.initia.example";
const IUSD_DENOM = "move/6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e";
const IUSD_METADATA = "0x6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e";
const VAULT_OWNER = "0xfd6a07594842ac5d7501ff55243aff06e4f991f320828be05a4590970145e90a";
const AUSD0_METADATA = "0x8078cf9fee50e15069402e9d1d9db70b28fc0d5197d79e8a2b41e2ade432efef";
const MOVE_METADATA_TYPE = "0x1::fungible_asset::Metadata";
const MOVE_OBJECT_CORE_TYPE = "0x1::object::ObjectCore";
const IUSD_SUPPLY = "2519552759503";

const coin: StablecoinMeta = {
  id: "iusd-initia",
  name: "Initia iUSD",
  symbol: "iUSD",
  flags: {
    backing: "rwa-backed",
    pegCurrency: "USD",
    governance: "centralized-dependent",
    yieldBearing: false,
    rwa: false,
    navToken: false,
  },
};

function config(): LiveReservesConfig {
  return {
    adapter: "initia-wrapper-vault",
    version: 1,
    semantics: "single-asset",
    inputs: { primary: { kind: "http-json", url: BASE_URL } },
    params: {
      lcdUrl: BASE_URL,
      iusdDenom: IUSD_DENOM,
      iusdMetadataAddress: IUSD_METADATA,
      vaultOwnerAddress: VAULT_OWNER,
      ausd0MetadataAddress: AUSD0_METADATA,
      decimals: 6,
      slice: {
        name: "Agora AUSD bridged via LayerZero (Initia AUSD0)",
        risk: "low",
        coinId: "ausd-agora",
        depType: "wrapper",
      },
    },
  } as unknown as LiveReservesConfig;
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

function mockHealthyReads(vaultBalance = IUSD_SUPPLY): void {
  vi.mocked(fetchJsonPostWithRetry).mockResolvedValue({ data: JSON.stringify(vaultBalance), events: [], gas_used: "7553" });
  vi.mocked(fetchJsonWithRetry)
    .mockResolvedValueOnce({ amount: { denom: IUSD_DENOM, amount: IUSD_SUPPLY } })
    .mockResolvedValueOnce(resource(IUSD_METADATA, MOVE_OBJECT_CORE_TYPE, { owner: VAULT_OWNER }))
    .mockResolvedValueOnce(resource(AUSD0_METADATA, MOVE_METADATA_TYPE, {
      name: "AUSD0",
      symbol: "AUSD0",
      decimals: 6,
      project_uri: "https://www.agora.finance",
    }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchInitiaWrapperVaultReserves", () => {
  it("reads the recorded Initia responses and emits one 100% parent slice", async () => {
    mockHealthyReads();

    const result = await fetchInitiaWrapperVaultReserves(coin, config(), new AbortController().signal);

    expect(result.slices).toEqual([
      {
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
    expect(fetchJsonPostWithRetry).toHaveBeenCalledTimes(1);
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(3);
    expect(fetchJsonPostWithRetry).toHaveBeenCalledWith(
      `${BASE_URL}/initia/move/v1/view/json`,
      {
        address: "0x1",
        module_name: "primary_fungible_store",
        function_name: "balance",
        type_args: [MOVE_METADATA_TYPE],
        args: [JSON.stringify(VAULT_OWNER), JSON.stringify(AUSD0_METADATA)],
      },
      expect.any(AbortSignal),
      12_000,
      undefined,
    );
  });

  it("fails closed when the iUSD ObjectCore is no longer owned by the vault", async () => {
    vi.mocked(fetchJsonPostWithRetry).mockResolvedValue({ data: JSON.stringify(IUSD_SUPPLY) });
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({ amount: { denom: IUSD_DENOM, amount: IUSD_SUPPLY } })
      .mockResolvedValueOnce(resource(IUSD_METADATA, MOVE_OBJECT_CORE_TYPE, {
        owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
      }));

    await expect(fetchInitiaWrapperVaultReserves(coin, config(), new AbortController().signal))
      .rejects.toThrow("iUSD metadata owner mismatch");
    expect(fetchJsonPostWithRetry).toHaveBeenCalledTimes(1);
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(2);
  });
});
