import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { CG_CHAIN_MAP, GT_CHAIN_MAP, getActiveChainIds, getChainResilienceTier } from "@shared/lib/chains";
import { CHAIN_META, normalizeChainId, resolveChainId } from "../../types/chain-identity";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

const PUBLIC_DIR = resolve(import.meta.dirname, "../../../public");

describe("CHAIN_META", () => {
  it("declares only local /chains/ logos that exist as files under public/", () => {
    const problems: string[] = [];
    for (const [id, meta] of Object.entries(CHAIN_META)) {
      if (!meta.logoPath) continue; // an intentionally empty logo falls back to the name badge
      const file = resolve(PUBLIC_DIR, `.${meta.logoPath}`);
      const isFile = (() => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      })();
      if (!meta.logoPath.startsWith("/chains/") || !file.startsWith(`${PUBLIC_DIR}${sep}chains${sep}`) || !isFile) {
        problems.push(`${id}: ${meta.logoPath}`);
      }
    }
    expect(problems).toEqual([]);
  });

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

});

describe("getActiveChainIds", () => {
  it("returns every CHAIN_META key, including chains without tracked supply", () => {
    const ids = getActiveChainIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(CHAIN_META[id]).toBeDefined();
    }
    expect(ids).toContain("ethereum");
    expect(ids).toEqual(Object.keys(CHAIN_META).sort());
  });

});

describe("resolveChainId", () => {
  it("deduplicates the Hyperliquid alias to the canonical key", () => {
    expect(resolveChainId("hyperliquid")).toBe("hyperliquid");
    expect(resolveChainId("hyperliquid-l1")).toBe("hyperliquid");
    expect(resolveChainId("Hyperliquid L1")).toBe("hyperliquid");
  });

  it("resolves every CHAIN_META key, display name and EVM chain ID back to its key", () => {
    const names = new Map<string, string>();
    for (const [id, meta] of Object.entries(CHAIN_META)) {
      expect(resolveChainId(id), id).toBe(id);
      const normalizedName = normalizeChainId(meta.name);
      expect(normalizedName, id).not.toBeNull();
      expect(resolveChainId(meta.name), id).toBe(id);
      // A display name may never alias two canonical chains.
      expect(names.get(normalizedName!) ?? id, `${id}/${meta.name}`).toBe(id);
      names.set(normalizedName!, id);
      if (meta.evmChainId != null) {
        expect(resolveChainId(meta.evmChainId), id).toBe(id);
      }
    }
  });

  it("registers canonical VeChain mainnet identity without claiming provider coverage", () => {
    expect(CHAIN_META.vechain).toMatchObject({
      name: "VeChain",
      explorerUrl: "https://explore.vechain.org",
      evmChainId: 100009,
      type: "evm",
    });
    expect(resolveChainId(" VeChain ")).toBe("vechain");
    expect(resolveChainId("vechain")).toBe("vechain");
    expect(resolveChainId(100009)).toBe("vechain");
    expect(resolveChainId(100010)).toBeNull();
    expect(CHAIN_META.vechain.providers).toBeUndefined();
    expect(CG_CHAIN_MAP.vechain).toBeUndefined();
    expect(GT_CHAIN_MAP.vechain).toBeUndefined();
  });

  it("joins exSat provider labels and mainnet IDs without inventing pool coverage", () => {
    for (const identity of ["exSat", " EXSAT ", "exsat", 7200]) {
      expect(resolveChainId(identity)).toBe("exsat");
      expect(normalizeChainId(identity)).toBe("exsat");
    }
    expect(resolveChainId(7201)).toBeNull();
    expect(CG_CHAIN_MAP.exsat).toBeUndefined();
    expect(GT_CHAIN_MAP.exsat).toBeUndefined();
  });

  it("maps IOTA EVM to CoinGecko Onchain's verified network id", () => {
    expect(CG_CHAIN_MAP["iota-evm"]).toBe("iota-evm");
  });

  it("resolves DefiLlama chain names that differ from local metadata names", () => {
    expect(resolveChainId("OP Mainnet")).toBe("optimism");
    expect(resolveChainId("Plume Mainnet")).toBe("plume");
    expect(resolveChainId("ZKsync Era")).toBe("zksync");
    expect(resolveChainId("Kaia")).toBe("klaytn");
    expect(resolveChainId("edgeX L1")).toBe("edgechain");
    expect(resolveChainId("Echelon Initia")).toBe("initia");
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

  it("keeps newer RISE and Somnia below the established Filecoin tier", () => {
    expect(getChainResilienceTier("rise")).toBe(3);
    expect(getChainResilienceTier("somnia")).toBe(3);
    expect(getChainResilienceTier("filecoin")).toBe(2);
  });
});

describe("tracked contract chain coverage", () => {
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
