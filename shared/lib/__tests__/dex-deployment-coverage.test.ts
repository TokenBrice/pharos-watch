import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "../stablecoins/registry";
import {
  AQUARIUS_SUPPORTED_TOKEN_IDS,
  DEX_COVERAGE_WAIVERS,
  DEX_DISCOVERY_PROVIDER_EXHAUSTIVENESS,
  getActiveDexCoverageWaiver,
  getDexDiscoveryProviders,
  getGeckoTerminalDiscoveryTarget,
  getHorizonDiscoveryAsset,
  isAquariusSorobanDeployment,
  isIconBalancedDiscoveryDeployment,
  isKavaSwapDiscoveryDeployment,
  isTezosDiscoveryDeployment,
} from "../dex-deployment-coverage";
import type { DexDiscoveryProvider } from "../dex-deployment-coverage";
import type { LiquidityPoolSourceFamily } from "@shared/types/market";

const NEW_DISCOVERY_PROVIDER_TYPE_PINS = ["aquarius", "tezos", "icon-balanced", "kava-swap"] as const satisfies readonly DexDiscoveryProvider[];
const NEW_SOURCE_FAMILY_TYPE_PINS = ["aquarius", "tezos", "icon-balanced", "kava-swap"] as const satisfies readonly LiquidityPoolSourceFamily[];

const REVIEW_AT_SEC = Date.UTC(2026, 6, 10) / 1000;

describe("DEX deployment coverage ownership", () => {
  it("classifies the audited unsupported deployment universe exactly", () => {
    const unsupported: Array<{ stablecoinId: string; chain: string; address: string }> = [];
    const exclusivelyUnsupported: string[] = [];

    for (const meta of ACTIVE_STABLECOINS) {
      const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
      const inaccessible = deployments.filter(
        (deployment) => getDexDiscoveryProviders(deployment.chain, deployment.address).length === 0,
      );
      unsupported.push(
        ...inaccessible.map((deployment) => ({
          stablecoinId: meta.id,
          chain: deployment.chain,
          address: deployment.address,
        })),
      );
      if (deployments.length > 0 && inaccessible.length === deployments.length) {
        exclusivelyUnsupported.push(meta.id);
      }
    }

    expect(unsupported).toHaveLength(40);
    expect(new Set(unsupported.map((row) => row.stablecoinId)).size).toBe(29);
    expect(exclusivelyUnsupported).toHaveLength(2);
    expect(getDexDiscoveryProviders("stellar")).toEqual(["horizon"]);
  });

  it("pins the four new provider and source-family identities", () => {
    expect(NEW_DISCOVERY_PROVIDER_TYPE_PINS).toHaveLength(4);
    expect(NEW_SOURCE_FAMILY_TYPE_PINS).toHaveLength(4);
    expect(Object.keys(AQUARIUS_SUPPORTED_TOKEN_IDS)).toHaveLength(8);
    expect(DEX_DISCOVERY_PROVIDER_EXHAUSTIVENESS).toMatchObject({
      aquarius: false,
      tezos: true,
      "icon-balanced": false,
      "kava-swap": false,
    });
  });

  it("registers the exact new provider deployment identities", () => {
    const aquariusToken = Object.keys(AQUARIUS_SUPPORTED_TOKEN_IDS)[0]!;
    const tezosAddress = "KT1XRPEPXbZK25r3Htzp2o1x7xdMMmfocKNW";
    const iconAddress = "cx88fd7df7ddff82f7cc735c871dc519838cb235bb";

    expect(isAquariusSorobanDeployment("stellar", `EUTBL-${aquariusToken}`)).toBe(true);
    expect(getDexDiscoveryProviders("stellar", `EUTBL-${aquariusToken}`)).toEqual(["aquarius"]);
    expect(isAquariusSorobanDeployment("stellar", "CDE57N6XTUPBKYYDGQMXX7E7SLNOLFY3JEQB4MULSMR2AKTSAENGX2HC")).toBe(false);
    expect(isTezosDiscoveryDeployment("tezos", tezosAddress)).toBe(true);
    expect(getDexDiscoveryProviders("tezos", tezosAddress)).toEqual(["tezos"]);
    expect(getDexDiscoveryProviders("tezos", `${tezosAddress}x`)).toEqual([]);
    expect(isIconBalancedDiscoveryDeployment("icon", iconAddress.toUpperCase())).toBe(true);
    expect(getDexDiscoveryProviders("icon", iconAddress.toUpperCase())).toEqual(["icon-balanced"]);
    expect(isKavaSwapDiscoveryDeployment("kava", " USDX ")).toBe(true);
    expect(getDexDiscoveryProviders("kava", "usdx")).toEqual([
      "coingecko",
      "geckoterminal",
      "dexscreener",
      "curve",
      "kava-swap",
    ]);
  });

  it("registers only the exact supplemental GeckoTerminal deployment shapes", () => {
    expect(getGeckoTerminalDiscoveryTarget("starknet", "0xabc")).toEqual({
      network: "starknet-alpha",
      address: `0x${"abc".padStart(64, "0")}`,
    });
    expect(getGeckoTerminalDiscoveryTarget("stacks", "SP123.token")).toEqual({
      network: "stacks",
      address: "SP123.token",
    });
    expect(getGeckoTerminalDiscoveryTarget("mantra", "0x866A2BF4E572CBCF37D5071A7A58503BFB36BE1B")).toEqual({
      network: "mantra-evm",
      address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b",
    });
    expect(getGeckoTerminalDiscoveryTarget("hedera", "0.0.6070123")).toEqual({
      network: "hedera-hashgraph",
      address: "0x00000000000000000000000000000000005c9f6b",
    });
    expect(getGeckoTerminalDiscoveryTarget("hedera", "0x00000000000000000000000000000000009Ce723")).toEqual({
      network: "hedera-hashgraph",
      address: "0x00000000000000000000000000000000009ce723",
    });
    expect(getGeckoTerminalDiscoveryTarget("hedera", "0.0.18446744073709551615")).toEqual({
      network: "hedera-hashgraph",
      address: "0x000000000000000000000000ffffffffffffffff",
    });
    expect(getGeckoTerminalDiscoveryTarget("hedera", "0.0.18446744073709551616")).toBeNull();
    expect(getGeckoTerminalDiscoveryTarget("injective", "0xa00c59ff5a080d2b954d0c75e46e22a0c371235a")).toEqual({
      network: "injective",
      address: "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
    });
    expect(getGeckoTerminalDiscoveryTarget("injective", "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7")).toEqual({
      network: "injective",
      address: "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7",
    });
    expect(
      getGeckoTerminalDiscoveryTarget(
        "injective",
        "ibc/93eae5f9d6c14bfac8dd1afdbe95501055a7b22c5d8fa8c986c31d6efadca8a9",
      ),
    ).toEqual({
      network: "injective",
      address: "ibc/93EAE5F9D6C14BFAC8DD1AFDBE95501055A7B22C5D8FA8C986C31D6EFADCA8A9",
    });
    expect(
      getGeckoTerminalDiscoveryTarget(
        "injective",
        "factory/inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk/inj1qspaxnztkkzahvp6scq6xfpgafejmj2td83r9j",
      ),
    ).toEqual({
      network: "injective",
      address: "factory/inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk/inj1qspaxnztkkzahvp6scq6xfpgafejmj2td83r9j",
    });
    expect(
      getGeckoTerminalDiscoveryTarget(
        "mantra",
        "ibc/6749D16BC09F419C090C330FC751FFF1C96143DB7A4D2FCAEC2F348A3E17618A",
      ),
    ).toBeNull();
    expect(getDexDiscoveryProviders("mantra")).toEqual([]);
    expect(getGeckoTerminalDiscoveryTarget("hedera", "0.1.6070123")).toBeNull();
    expect(getGeckoTerminalDiscoveryTarget("injective", "not-a-denom")).toBeNull();
  });

  it("registers Horizon only for classic Stellar deployment identities", () => {
    const issuer = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";
    const classic = `EURC-${issuer}`;
    const soroban = "CDWOB6T7SVSMMQN5V3P2OPTBAXOP7DAZHGVW3PYTZIKHVFKN6TBSXR6A";

    expect(getDexDiscoveryProviders("stellar", classic)).toEqual(["horizon"]);
    expect(getHorizonDiscoveryAsset(classic, "EURC")).toBe(`EURC:${issuer}`);
    expect(getHorizonDiscoveryAsset(issuer, "EURC")).toBe(`EURC:${issuer}`);
    expect(getDexDiscoveryProviders("stellar", soroban)).toEqual(["aquarius"]);
    expect(getHorizonDiscoveryAsset(soroban, "EURSPKCC")).toBeNull();
  });

  it("gives every exclusively inaccessible coin an owned, unexpired waiver", () => {
    const exclusivelyUnsupported = ACTIVE_STABLECOINS.filter((meta) => {
      const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
      return (
        deployments.length > 0 &&
        deployments.every(
          (deployment) => getDexDiscoveryProviders(deployment.chain, deployment.address).length === 0,
        )
      );
    });

    const missing = exclusivelyUnsupported.flatMap((meta) => {
      const chains = new Set([...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])].map((row) => row.chain));
      return [...chains]
        .filter((chain) => getActiveDexCoverageWaiver(meta.id, chain, REVIEW_AT_SEC) == null)
        .map((chain) => `${meta.id}:${chain}`);
    });

    expect(missing).toEqual([]);
    expect(DEX_COVERAGE_WAIVERS).toHaveLength(4);
    expect(DEX_COVERAGE_WAIVERS.every((waiver) => waiver.owner.length > 0 && waiver.expiresAt > REVIEW_AT_SEC)).toBe(
      true,
    );
  });
});
