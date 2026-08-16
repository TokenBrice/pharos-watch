import { describe, expect, it } from "vitest";

import {
  CG_CHAIN_MAP,
  CHAIN_META,
  GT_CHAIN_MAP,
  getActiveChainIds,
  getChainResilienceTier,
  normalizeChainId,
  resolveChainId,
} from "@shared/lib/chains";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

describe("CHAIN_META", () => {
  it("exposes only lowercase chain keys", () => {
    const keys = Object.keys(CHAIN_META);

    expect(keys.every((key) => key === key.toLowerCase())).toBe(true);
  });

  it("uses unique EVM chain IDs", () => {
    const evmIds = Object.values(CHAIN_META)
      .filter((meta) => meta.type === "evm" && meta.evmChainId != null)
      .map((meta) => meta.evmChainId!);

    expect(new Set(evmIds).size).toBe(evmIds.length);
  });

  it("keeps non-EVM chains without EVM chain IDs", () => {
    for (const meta of Object.values(CHAIN_META)) {
      if (meta.type !== "evm") {
        expect(meta.evmChainId == null).toBe(true);
      }
    }
  });

  it("requires explorer URLs to be https", () => {
    for (const meta of Object.values(CHAIN_META)) {
      expect(meta.explorerUrl.startsWith("https://")).toBe(true);
    }
  });
});

describe("getActiveChainIds", () => {
  it("returns chain IDs that appear in both contracts and CHAIN_META", () => {
    const ids = getActiveChainIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(CHAIN_META[id]).toBeDefined();
    }
    expect(ids).toContain("ethereum");
  });

  it("returns sorted, deduplicated IDs", () => {
    const ids = getActiveChainIds();
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveChainId", () => {
  it("deduplicates the Hyperliquid alias to the canonical key", () => {
    expect(resolveChainId("hyperliquid")).toBe("hyperliquid");
    expect(resolveChainId("hyperliquid-l1")).toBe("hyperliquid");
    expect(resolveChainId("Hyperliquid L1")).toBe("hyperliquid");
  });

  it("resolves the newly tracked citrea chain", () => {
    expect(resolveChainId("citrea")).toBe("citrea");
    expect(CHAIN_META.citrea).toBeDefined();
  });

  it("registers and resolves Pharos Network mainnet", () => {
    expect(CHAIN_META.pharos).toMatchObject({
      name: "Pharos Network",
      explorerUrl: "https://www.pharosscan.xyz",
      evmChainId: 1672,
      type: "evm",
    });
    expect(CG_CHAIN_MAP.pharos).toBe("pharos");
    expect(GT_CHAIN_MAP.pharos).toBe("pharos");
    expect(resolveChainId("pharos")).toBe("pharos");
    expect(resolveChainId("Pharos")).toBe("pharos");
  });

  it("resolves DefiLlama chain names that differ from local metadata names", () => {
    expect(resolveChainId("XDC")).toBe("xdc");
    expect(resolveChainId("ZKsync Era")).toBe("zksync");
    expect(resolveChainId("Abcore")).toBe("abcore");
    expect(resolveChainId("edgeX L1")).toBe("edgechain");
  });
});

describe("normalizeChainId", () => {
  it("trims and resolves canonical keys, display names, and aliases case-insensitively", () => {
    expect(normalizeChainId(" Ethereum ")).toBe("ethereum");
    expect(normalizeChainId(" OP Mainnet ")).toBe("optimism");
    expect(normalizeChainId(" HYPERLIQUID-L1 ")).toBe("hyperliquid");
  });

  it("resolves numeric EVM IDs through the precomputed reverse index", () => {
    expect(resolveChainId(1)).toBe("ethereum");
    expect(normalizeChainId(42161)).toBe("arbitrum");
    expect(resolveChainId(999_999_999)).toBeNull();
    expect(normalizeChainId(999_999_999)).toBe("999999999");
  });

  it("retains unknown labels in one normalized form and rejects blank or non-finite input", () => {
    expect(resolveChainId(" New Chain ")).toBeNull();
    expect(normalizeChainId(" New Chain ")).toBe("new chain");
    expect(normalizeChainId("   ")).toBeNull();
    expect(normalizeChainId(null)).toBeNull();
    expect(normalizeChainId(Number.NaN)).toBeNull();
  });
});

describe("getChainResilienceTier", () => {
  it("treats BEVM as a tier-3 chain", () => {
    expect(getChainResilienceTier("bevm")).toBe(3);
  });

  it("treats the newly launched Pharos Network as tier 3", () => {
    expect(getChainResilienceTier("pharos")).toBe(3);
  });
});

describe("tracked contract chain coverage", () => {
  it("tracks the verified Reservoir deployments on Pharos", () => {
    expect(TRACKED_META_BY_ID.get("rusd-reservoir")?.contracts).toContainEqual({
      chain: "pharos",
      address: "0x09d4214c03d01f49544c0448dbe3a27f768f2b34",
      decimals: 18,
    });
    expect(TRACKED_META_BY_ID.get("wsrusd-reservoir")?.contracts).toContainEqual({
      chain: "pharos",
      address: "0x4809010926aec940b550d34a46a52739f996d75d",
      decimals: 18,
    });
  });

  it("keeps every tracked contract chain resolvable through the canonical chain registry", () => {
    const issues = Array.from(TRACKED_META_BY_ID.values()).flatMap((stablecoin) => (
      stablecoin.contracts?.flatMap((contract, contractIndex) => (
        resolveChainId(contract.chain)
          ? []
          : [`${stablecoin.id}[${contractIndex}]=${contract.chain}`]
      )) ?? []
    ));

    expect(issues).toEqual([]);
  });
});
