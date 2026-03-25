import { describe, it, expect } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { CG_CHAIN_MAP, DS_CHAIN_MAP } from "@shared/lib/chain-provider-registry";

/** Chains with no standard DEX infrastructure — intentionally unsupported */
const UNSUPPORTED_CHAINS = new Set([
  "algorand", "aptos", "astar", "aurora", "bittorrent", "boba",
  "fraxtal", "hedera", "hydration", "icp", "kava",
  "klaytn", "mantra", "metis", "moonbeam", "moonriver", "morph-l2",
  "near", "noble", "osmosis", "polkadot", "polygon-zkevm",
  "starknet", "stellar", "swellchain", "tezos", "ton", "viction",
  "xdc", "xlayer", "xrpl", "zircuit", "bitlayer", "apechain",
  // Added with 78-contract enrichment batch — not yet mapped to CG/DS liquidity sources
  "injective", "flare", "corn", "cronos", "stacks", "etherlink",
  "cardano", "pulsechain", "abstract", "katana", "abcore", "flow",
  "provenance", "movement", "nibiru", "immutable-zkevm", "bsquared",
  "songbird", "sophon", "mezo", "bifrost", "hemi",
  // Tracked for contract display, but not yet wired into the DEX liquidity pipeline
  "citrea", "conflux", "harmony", "secret",
]);

describe("liquidity coverage", () => {
  it("every contract chain is mapped in CG, DS, or explicitly unsupported", () => {
    const unmapped: string[] = [];
    const allChains = new Set<string>();
    for (const meta of ACTIVE_STABLECOINS) {
      for (const c of meta.contracts ?? []) {
        allChains.add(c.chain);
      }
      for (const c of meta.tradedContracts ?? []) {
        allChains.add(c.chain);
      }
    }
    for (const chain of allChains) {
      if (!CG_CHAIN_MAP[chain] && !DS_CHAIN_MAP[chain] && !UNSUPPORTED_CHAINS.has(chain)) {
        unmapped.push(chain);
      }
    }
    expect(unmapped).toEqual([]);
  });

  it("all colliding symbols have contracts for address-based disambiguation", () => {
    const symbolToIds = new Map<string, string[]>();
    for (const meta of ACTIVE_STABLECOINS) {
      const key = meta.symbol.toUpperCase();
      const ids = symbolToIds.get(key) ?? [];
      ids.push(meta.id);
      symbolToIds.set(key, ids);
    }

    const missing: string[] = [];
    for (const [symbol, ids] of symbolToIds) {
      if (ids.length <= 1) continue;
      for (const id of ids) {
        const meta = ACTIVE_STABLECOINS.find((m) => m.id === id);
        // Small symbols can rely on external IDs when there is no contract footprint.
        if (!meta?.contracts?.length && !meta?.tradedContracts?.length && (meta?.geckoId || meta?.cmcSlug)) continue;
        if (!meta?.contracts?.length && !meta?.tradedContracts?.length) {
          missing.push(`${symbol} (id=${id}) has no contracts for disambiguation`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
