import { describe, expect, it } from "vitest";
import { resolveExactDexPublicationGeneration } from "../report-cards-snapshot";

const ACTIVE_IDS = ["coin-a", "coin-b"];
const UPDATED_AT = 1_783_891_100;
const GENERATION = `dex-liquidity-${UPDATED_AT}`;

function row(stablecoinId: string, generationId: string | null = GENERATION, updatedAt: number | null = UPDATED_AT) {
  return {
    stablecoin_id: stablecoinId,
    publication_generation_id: generationId,
    updated_at: updatedAt,
  };
}

describe("exact report-card input DEX generation", () => {
  it("accepts one complete active generation while ignoring retained inactive rows", () => {
    expect(
      resolveExactDexPublicationGeneration([...ACTIVE_IDS.map((id) => row(id)), row("inactive", "old", 1)], ACTIVE_IDS),
    ).toEqual({ generationId: GENERATION, updatedAt: UPDATED_AT });
  });

  it("rejects missing, mixed, legacy-null, and timestamp-mismatched active rows", () => {
    expect(() => resolveExactDexPublicationGeneration([row("coin-a")], ACTIVE_IDS)).toThrow(
      "missing 1 active DEX rows",
    );
    expect(() =>
      resolveExactDexPublicationGeneration([row("coin-a"), row("coin-b", "dex-liquidity-2", 2)], ACTIVE_IDS),
    ).toThrow("spans 2 active DEX generations");
    expect(() => resolveExactDexPublicationGeneration([row("coin-a"), row("coin-b", null)], ACTIVE_IDS)).toThrow(
      "active DEX generations",
    );
    expect(() =>
      resolveExactDexPublicationGeneration(
        [row("coin-a", "dex-liquidity-999", 999), row("coin-b", "dex-liquidity-999", 999)],
        ACTIVE_IDS,
      ),
    ).not.toThrow();
    expect(() =>
      resolveExactDexPublicationGeneration(
        [row("coin-a", "wrong-generation", 999), row("coin-b", "wrong-generation", 999)],
        ACTIVE_IDS,
      ),
    ).toThrow("does not match row timestamp");
  });
});
