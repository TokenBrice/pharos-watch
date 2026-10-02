import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LiveReservesConfigSchema,
} from "@shared/lib/live-reserve-adapters";
import { CHAIN_META } from "../../types/chain-identity";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LiabilityScope } from "@shared/types/live-reserve-adapter-declarations";

const COIN_SOURCE_DIR = join(process.cwd(), "shared/data/stablecoins/coins");

const RESERVE_SOURCE_DIR = join(process.cwd(), "shared/data/stablecoins/domains/reserves");

interface CoinSource {
  contracts?: Array<{ chain: string; address: string }>;
  liveReservesConfig?: {
    adapter: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS;
    scoring?: { maxSourceAgeSec?: number };
    inputs?: { primary?: { chain?: string } };
    params?: {
      slice?: { expectedAssetAddress?: string };
      pooledClaim?: { basis: string; reviewedAt: string; sourceUrl: string };
      liabilityScope?: LiabilityScope;
    };
  };
}

let coinSources: Map<string, CoinSource> | undefined;

function getCoinSources(): Map<string, CoinSource> {
  return coinSources ??= new Map(
    readdirSync(COIN_SOURCE_DIR)
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) => [
        fileName.slice(0, -5),
        JSON.parse(readFileSync(join(COIN_SOURCE_DIR, fileName), "utf8")) as CoinSource,
      ]),
  );
}

interface ReserveSource {
  reserves?: Array<{ sourceKey?: string }>;
}

let erc4626SidecarKeys: Map<string, Set<string>> | undefined;

function getErc4626SidecarKeys(): Map<string, Set<string>> {
  return (erc4626SidecarKeys ??= new Map(
    readdirSync(RESERVE_SOURCE_DIR)
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) => {
        const sidecar = JSON.parse(readFileSync(join(RESERVE_SOURCE_DIR, fileName), "utf8")) as ReserveSource;
        const keys = (sidecar.reserves ?? [])
          .map((row) => row.sourceKey?.toLowerCase() ?? "")
          .filter((sourceKey) => sourceKey.startsWith("erc4626-single-asset:"));
        return [fileName.slice(0, -5), new Set(keys)] as const;
      }),
  ));
}


describe("live reserve catalog integrity", () => {
  it("accepts configured live reserve URLs", () => {
    const failures: string[] = [];

    for (const coin of ACTIVE_STABLECOINS) {
      if (!coin.liveReservesConfig) continue;
      const parsed = LiveReservesConfigSchema.safeParse(coin.liveReservesConfig);
      if (!parsed.success) {
        failures.push(
          `${coin.id}: ${parsed.error.issues[0]?.path.join(".") ?? "config"} ${parsed.error.issues[0]?.message ?? "invalid"}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps every bound source-age override at or below its adapter cap", () => {
    const failures: string[] = [];
    // Read source JSONs as well as active bindings so suspended configurations are covered.
    for (const [id, source] of getCoinSources()) {
      const config = source.liveReservesConfig;
      const coinCap = config?.scoring?.maxSourceAgeSec;
      if (!config || coinCap == null) continue;
      const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter];
      const adapterCap = "validation" in definition && "maxSourceAgeSec" in definition.validation
        ? definition.validation.maxSourceAgeSec
        : undefined;
      if (adapterCap != null && coinCap > adapterCap) {
        failures.push(`${id}: coin=${coinCap} adapter=${adapterCap}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("covers every erc4626-single-asset coin with a reviewed reserve slice", () => {
    const failures: string[] = [];
    const sidecarKeys = getErc4626SidecarKeys();
    for (const [id, source] of getCoinSources()) {
      const config = source.liveReservesConfig;
      if (!config || config.adapter !== "erc4626-single-asset") continue;
      const chain = config.inputs?.primary?.chain;
      const asset = config.params?.slice?.expectedAssetAddress?.toLowerCase();
      const vault = source.contracts?.find((contract) => contract.chain === chain)?.address.toLowerCase();
      // Pooled claims emit only the reviewed vault claim, never an allocation
      // to the accounting asset. Other modes retain the underlying-token idle
      // row or vault-keyed deployed strategy row.
      const sourceKeys = config.params?.pooledClaim
        ? chain && vault
          ? [`erc4626-single-asset:${chain}:${vault}:pooled-claim`]
          : []
        : chain && asset && vault
          ? [`erc4626-single-asset:${chain}:${asset}`, `erc4626-single-asset:${chain}:${vault}:deployed`]
          : [];
      const reviewedKeys = sidecarKeys.get(id);
      if (!sourceKeys.some((sourceKey) => reviewedKeys?.has(sourceKey))) {
        failures.push(`${id}: no reserve slice keyed ${sourceKeys.join(" or ") || "erc4626-single-asset:<chain>:<underlying-or-vault>"}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("classifies every catalog chain exactly once in each reviewed liability scope", () => {
    const failures: string[] = [];
    const readerChainType: Record<string, (chain: string) => boolean> = {
      "evm-erc20": (chain) => CHAIN_META[chain]?.type === "evm",
      "tron-trc20": (chain) => CHAIN_META[chain]?.type === "tron",
      "solana-spl-mint": (chain) => chain === "solana",
      "aptos-fungible-asset": (chain) => chain === "aptos",
    };
    for (const [id, source] of getCoinSources()) {
      const scope = source.liveReservesConfig?.params?.liabilityScope;
      if (scope?.basis !== "issuer-native-supply") continue;
      const catalogChains = (source.contracts ?? []).map((contract) => contract.chain).sort();
      const scopedChains = [...scope.included, ...scope.excluded].map((entry) => entry.chain).sort();
      if (JSON.stringify(catalogChains) !== JSON.stringify(scopedChains)) {
        failures.push(`${id}: catalog [${catalogChains.join(", ")}] vs scope [${scopedChains.join(", ")}]`);
      }
      for (const entry of scope.included) {
        if (!readerChainType[entry.reader]?.(entry.chain)) failures.push(`${id}: ${entry.reader} cannot read ${entry.chain}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
