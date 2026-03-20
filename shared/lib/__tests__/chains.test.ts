import { describe, expect, it } from "vitest";

import { CHAIN_META, getActiveChainIds, resolveChainId } from "@shared/lib/chains";

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
  });
});
