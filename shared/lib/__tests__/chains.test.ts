import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { CG_CHAIN_MAP, GT_CHAIN_MAP, getActiveChainIds, getChainResilienceTier } from "@shared/lib/chains";
import { normalizeDeploymentAddress, parseContractTuple } from "@shared/lib/deployment-resolver";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { CHAIN_META, normalizeChainId, resolveChainId } from "../../types/chain-identity";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

const PUBLIC_DIR = resolve(import.meta.dirname, "../../../public");

describe("CHAIN_META", () => {
  it("declares only local /chains/ logos that exist as files under public/", () => {
    const problems: string[] = [];
    for (const [id, meta] of Object.entries(CHAIN_META)) {
      if (!meta.logoPath) continue; // an intentionally empty logo falls back to the name badge
      const file = resolve(PUBLIC_DIR, `.${meta.logoPath}`);
      const isFile = statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
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

  it("registers VeChain, exSat, and Canton identities without claiming pool provider coverage", () => {
    expect(CHAIN_META.vechain).toMatchObject({ name: "VeChain", explorerUrl: "https://explore.vechain.org", evmChainId: 100009, type: "evm" });
    expect(CHAIN_META.canton).toMatchObject({ name: "Canton Network", explorerUrl: "https://lighthouse.cantonloop.com", evmChainId: null, type: "other" });
    for (const [raw, id] of [[" VeChain ", "vechain"], ["vechain", "vechain"], [100009, "vechain"], ["exSat", "exsat"], [" EXSAT ", "exsat"], ["exsat", "exsat"], [7200, "exsat"], ["canton-network", "canton"], ["Canton Network", "canton"]] as const) {
      expect(resolveChainId(raw)).toBe(id);
      expect(normalizeChainId(raw)).toBe(id);
    }
    expect(resolveChainId(100010)).toBeNull();
    expect(resolveChainId(7201)).toBeNull();
    for (const id of ["vechain", "exsat", "canton"]) {
      expect(CHAIN_META[id].providers).toBeUndefined();
      expect(CG_CHAIN_MAP[id]).toBeUndefined();
      expect(GT_CHAIN_MAP[id]).toBeUndefined();
    }
    const party = "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
    expect(parseContractTuple(`canton:${party}`)).toEqual({ rawChain: "canton", rawAddress: party });
    expect(normalizeDeploymentAddress("canton", party)).toBe(party);
    for (const [entityType, value, url] of [
      ["contract", party, `https://lighthouse.cantonloop.com/party/${encodeURIComponent(party)}`],
      ["address", party, `https://lighthouse.cantonloop.com/party/${encodeURIComponent(party)}`],
      ["contract", "004b73abcd", "https://lighthouse.cantonloop.com/contracts/004b73abcd"],
      ["tx", "1220abcd#1", "https://lighthouse.cantonloop.com/transactions/1220abcd%231"],
    ] as const) {
      expect(buildExplorerUrl({ chainKey: "canton", entityType, value })).toBe(url);
    }
    expect(CG_CHAIN_MAP["iota-evm"]).toBe("iota-evm");
  });

  it("resolves DefiLlama chain names and aliases", () => {
    for (const [alias, id] of [
      ["hyperliquid", "hyperliquid"], ["hyperliquid-l1", "hyperliquid"], ["Hyperliquid L1", "hyperliquid"],
      ["OP Mainnet", "optimism"], ["Plume Mainnet", "plume"], ["ZKsync Era", "zksync"],
      ["Kaia", "klaytn"], ["edgeX L1", "edgechain"], ["Echelon Initia", "initia"],
    ] as const) {
      expect(resolveChainId(alias)).toBe(id);
    }
  });
});

describe("normalizeChainId", () => {
  it("trims and resolves canonical keys, display names, and aliases case-insensitively", () => {
    for (const [raw, id] of [[" Ethereum ", "ethereum"], [" OP Mainnet ", "optimism"], [" HYPERLIQUID-L1 ", "hyperliquid"]] as const) {
      expect(normalizeChainId(raw)).toBe(id);
    }
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
    for (const empty of ["   ", null, Number.NaN] as const) expect(normalizeChainId(empty)).toBeNull();
  });
});

describe("getChainResilienceTier", () => {
  it("classifies tier-3 chains below established tier-2 chains", () => {
    for (const id of ["bevm", "pharos", "rise", "somnia", "canton"]) expect(getChainResilienceTier(id)).toBe(3);
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
