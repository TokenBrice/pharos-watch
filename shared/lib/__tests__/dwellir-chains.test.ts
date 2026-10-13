import { describe, expect, it } from "vitest";
import { DWELLIR_CHAINS, dwellirRpcUrl } from "../dwellir-chains";
import { CHAIN_META } from "../../types/chain-identity";

describe("Dwellir Growth endpoint capabilities", () => {
  it("keeps chain identities unique and consistent with the canonical registry", () => {
    expect(new Set(DWELLIR_CHAINS.map((entry) => entry.chainId)).size).toBe(DWELLIR_CHAINS.length);
    for (const entry of DWELLIR_CHAINS) {
      expect(entry.evmChainId).toBe(CHAIN_META[entry.chainId]?.evmChainId);
    }
  });

  it("defines inclusive measured spans only for admitted full or retained log capabilities", () => {
    const nodeCaps: Readonly<Record<string, number>> = { monad: 1_000, astar: 1_024 };
    for (const entry of DWELLIR_CHAINS) {
      if (entry.logsHistory === "none") {
        expect(entry.maxLogBlockSpan).toBeUndefined();
      } else {
        expect(entry.maxLogBlockSpan).toBe(nodeCaps[entry.chainId] ?? 10_000);
        expect(entry.verifiedAt).toBe(
          entry.chainId === "ethereum" || entry.chainId === "arc" ? "2026-10-13" : "2026-10-11",
        );
      }
    }
  });

  it("uses Polygon's verified archive host and preserves archive observations", () => {
    const polygon = DWELLIR_CHAINS.find((entry) => entry.chainId === "polygon")!;
    expect(dwellirRpcUrl(polygon)).toBe("https://api-polygon-mainnet.n.dwellir.com");
    for (const chainId of ["polygon", "berachain", "plasma"]) {
      expect(DWELLIR_CHAINS.find((entry) => entry.chainId === chainId)).toMatchObject({
        stateHistory: "archive", verifiedAt: "2026-10-11",
      });
    }
  });

  it("uses Ethereum's 10k archive host and admits Arc's restored full history", () => {
    const ethereum = DWELLIR_CHAINS.find((entry) => entry.chainId === "ethereum")!;
    expect(dwellirRpcUrl(ethereum)).toBe("https://api-ethereum-mainnet.n.dwellir.com");
    for (const chainId of ["ethereum", "arc"]) {
      expect(DWELLIR_CHAINS.find((entry) => entry.chainId === chainId)).toMatchObject({
        stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-13",
      });
    }
  });

  it("keeps bounded history distinct from full logs and does not admit zkSync history", () => {
    expect(DWELLIR_CHAINS.find((entry) => entry.chainId === "monad")).toMatchObject({
      stateHistory: "recent", logsHistory: { retainedBlocks: 1_400_000 },
    });
    expect(DWELLIR_CHAINS.find((entry) => entry.chainId === "zksync")).toMatchObject({
      stateHistory: "recent", logsHistory: "none",
    });
  });
});
