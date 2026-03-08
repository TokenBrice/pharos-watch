import { describe, it, expect } from "vitest";
import {
  DEAD_BY_LLAMA_ID,
  REGISTRY_BY_ID,
  REGISTRY_BY_LLAMA_ID,
  REGISTRY_BY_GECKO_ID,
  REGISTRY_BY_CMC_SLUG,
  resolveStablecoinId,
  resolveByExternalId,
  getLlamaId,
} from "@shared/lib/stablecoin-id-registry";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { SHADOW_STABLECOINS } from "@shared/lib/shadow-stablecoins";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";

const USDT_META = REGISTRY_BY_LLAMA_ID.get("1");
const CANONICAL_USDT_ID = USDT_META?.id ?? "1";
const GECKO_ONLY_ID = TRACKED_STABLECOINS.find(
  (stablecoin) => stablecoin.geckoId && !stablecoin.llamaId,
)?.id;

describe("REGISTRY_BY_ID", () => {
  it("contains all tracked stablecoins", () => {
    expect(REGISTRY_BY_ID.size).toBeGreaterThanOrEqual(TRACKED_STABLECOINS.length);
  });

  it("contains shadow stablecoins", () => {
    for (const shadow of SHADOW_STABLECOINS) {
      expect(REGISTRY_BY_ID.has(shadow.id)).toBe(true);
    }
  });

  it("has no duplicate canonical IDs", () => {
    expect(REGISTRY_BY_ID.size).toBe(TRACKED_STABLECOINS.length + SHADOW_STABLECOINS.length);
  });

  it("module loads without duplicate-key assertion errors", () => {
    expect(REGISTRY_BY_ID).toBeInstanceOf(Map);
  });
});

describe("REGISTRY_BY_LLAMA_ID", () => {
  it("maps numeric llamaId to meta", () => {
    expect(REGISTRY_BY_LLAMA_ID.get("1")?.symbol).toBe("USDT");
  });

  it("has no duplicate llamaIds", () => {
    const llamaIdCount = [...TRACKED_STABLECOINS, ...SHADOW_STABLECOINS].filter(
      (stablecoin) => stablecoin.llamaId,
    ).length;

    expect(REGISTRY_BY_LLAMA_ID.size).toBe(llamaIdCount);
  });
});

describe("resolveStablecoinId", () => {
  it("resolves canonical ID directly", () => {
    expect(resolveStablecoinId(CANONICAL_USDT_ID)).toEqual({
      canonicalId: CANONICAL_USDT_ID,
    });
  });

  it("returns null for llamaId (legacy IDs no longer accepted)", () => {
    if (CANONICAL_USDT_ID === "1") {
      // If canonical happens to equal llamaId, it resolves via REGISTRY_BY_ID
      expect(resolveStablecoinId("1")).toEqual({ canonicalId: "1" });
      return;
    }
    expect(resolveStablecoinId("1")).toBeNull();
  });

  it("returns null for unknown ID", () => {
    expect(resolveStablecoinId("nonexistent-id-99999")).toBeNull();
  });
});

describe("REGISTRY_BY_CMC_SLUG", () => {
  it("maps cmcSlug to meta", () => {
    expect(REGISTRY_BY_CMC_SLUG.get("jupusd")?.symbol).toBe("JUPUSD");
  });

  it("skips entries without cmcSlug", () => {
    expect(REGISTRY_BY_CMC_SLUG.size).toBeLessThan(TRACKED_STABLECOINS.length);
  });
});

describe("resolveByExternalId", () => {
  it("resolves defillama ID", () => {
    expect(resolveByExternalId("defillama", "1")?.symbol).toBe("USDT");
  });

  it("resolves coingecko ID", () => {
    expect(REGISTRY_BY_GECKO_ID.get("tether")?.symbol).toBe("USDT");
    expect(resolveByExternalId("coingecko", "tether")?.symbol).toBe("USDT");
  });

  it("resolves cmc slug", () => {
    expect(resolveByExternalId("cmc", "jupusd")?.symbol).toBe("JUPUSD");
  });

  it("returns null for unknown external ID", () => {
    expect(resolveByExternalId("defillama", "999999")).toBeNull();
  });
});

describe("getLlamaId", () => {
  it("returns llamaId for a tracked stablecoin", () => {
    expect(getLlamaId(CANONICAL_USDT_ID)).toBe("1");
  });

  it("returns null for CoinGecko-sourced stablecoin", () => {
    expect(GECKO_ONLY_ID).toBeTruthy();
    expect(getLlamaId(GECKO_ONLY_ID!)).toBeNull();
  });

  it("returns null for non-existent ID", () => {
    expect(getLlamaId("does-not-exist")).toBeNull();
  });
});

describe("DEAD_BY_LLAMA_ID", () => {
  it("maps dead stablecoin llamaIds to names", () => {
    expect(DEAD_BY_LLAMA_ID.size).toBeGreaterThan(0);
  });

  it("skips dead stablecoins without llamaId", () => {
    expect(DEAD_BY_LLAMA_ID.size).toBeLessThan(DEAD_STABLECOINS.length);
  });
});
