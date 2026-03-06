import { describe, expect, it } from "vitest";

import { CHAIN_META } from "@shared/lib/chains";

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
