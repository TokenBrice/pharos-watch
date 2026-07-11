import { describe, it, expect } from "vitest";
import {
  PSI_INCLUSIVE_REGISTRY_BY_ID,
  READABLE_REGISTRY_BY_ID,
  REGISTRY_BY_ID,
  REGISTRY_BY_LLAMA_ID,
  REGISTRY_BY_GECKO_ID,
  REGISTRY_BY_CMC_SLUG,
  TRACKED_REGISTRY_BY_ID,
  resolvePsiInclusiveStablecoinId,
  resolveReadableStablecoinId,
  resolveStablecoinId,
  resolveTrackedStablecoinId,
} from "@shared/lib/stablecoin-id-registry";
import {
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import { SHADOW_STABLECOINS } from "@shared/lib/shadow-stablecoins";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";

const USDT_META = REGISTRY_BY_LLAMA_ID.get("1");
const CANONICAL_USDT_ID = USDT_META?.id ?? "1";
const PRE_LAUNCH_ID = PRE_LAUNCH_STABLECOINS[0]?.id;
const FROZEN_ID = FROZEN_STABLECOINS[0]?.id;
const SHADOW_ID = SHADOW_STABLECOINS[0]?.id;

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

  it("maps the audited Royal Dollar DefiLlama row", () => {
    expect(REGISTRY_BY_LLAMA_ID.get("415")?.id).toBe("rusd-royal-dollar");
  });

  it("has no duplicate llamaIds", () => {
    const llamaIdCount = [...TRACKED_STABLECOINS, ...SHADOW_STABLECOINS].filter(
      (stablecoin) => stablecoin.llamaId,
    ).length;

    expect(REGISTRY_BY_LLAMA_ID.size).toBe(llamaIdCount);
  });
});

describe("scoped ID registries", () => {
  it("keeps tracked, readable, and PSI-inclusive ID scopes explicit", () => {
    expect(TRACKED_REGISTRY_BY_ID.size).toBe(TRACKED_STABLECOINS.length);
    expect(READABLE_REGISTRY_BY_ID.size).toBe(ACTIVE_STABLECOINS.length + FROZEN_STABLECOINS.length);
    expect(PSI_INCLUSIVE_REGISTRY_BY_ID.size).toBe(ACTIVE_STABLECOINS.length + SHADOW_STABLECOINS.length);
  });

  it("excludes shadow-only IDs from tracked and readable registries", () => {
    expect(SHADOW_ID).toBeTruthy();
    expect(TRACKED_REGISTRY_BY_ID.has(SHADOW_ID!)).toBe(false);
    expect(READABLE_REGISTRY_BY_ID.has(SHADOW_ID!)).toBe(false);
    expect(PSI_INCLUSIVE_REGISTRY_BY_ID.has(SHADOW_ID!)).toBe(true);
  });

  it("keeps pre-launch IDs tracked but not readable or PSI-inclusive", () => {
    expect(PRE_LAUNCH_ID).toBeTruthy();
    expect(TRACKED_REGISTRY_BY_ID.has(PRE_LAUNCH_ID!)).toBe(true);
    expect(READABLE_REGISTRY_BY_ID.has(PRE_LAUNCH_ID!)).toBe(false);
    expect(PSI_INCLUSIVE_REGISTRY_BY_ID.has(PRE_LAUNCH_ID!)).toBe(false);
  });

  it("keeps frozen IDs readable but not PSI-inclusive", () => {
    expect(FROZEN_ID).toBeTruthy();
    expect(TRACKED_REGISTRY_BY_ID.has(FROZEN_ID!)).toBe(true);
    expect(READABLE_REGISTRY_BY_ID.has(FROZEN_ID!)).toBe(true);
    expect(PSI_INCLUSIVE_REGISTRY_BY_ID.has(FROZEN_ID!)).toBe(false);
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

  it("uses the readable public scope by default", () => {
    expect(PRE_LAUNCH_ID).toBeTruthy();
    expect(SHADOW_ID).toBeTruthy();
    expect(resolveStablecoinId(PRE_LAUNCH_ID!)).toBeNull();
    expect(resolveStablecoinId(SHADOW_ID!)).toBeNull();
  });
});

describe("scoped ID resolvers", () => {
  it("resolves tracked IDs including pre-launch and frozen entries", () => {
    expect(PRE_LAUNCH_ID).toBeTruthy();
    expect(FROZEN_ID).toBeTruthy();
    expect(resolveTrackedStablecoinId(PRE_LAUNCH_ID!)).toEqual({ canonicalId: PRE_LAUNCH_ID });
    expect(resolveTrackedStablecoinId(FROZEN_ID!)).toEqual({ canonicalId: FROZEN_ID });
    expect(resolveTrackedStablecoinId(SHADOW_ID!)).toBeNull();
  });

  it("resolves readable IDs but excludes pre-launch and shadow-only entries", () => {
    expect(FROZEN_ID).toBeTruthy();
    expect(resolveReadableStablecoinId(CANONICAL_USDT_ID)).toEqual({ canonicalId: CANONICAL_USDT_ID });
    expect(resolveReadableStablecoinId(FROZEN_ID!)).toEqual({ canonicalId: FROZEN_ID });
    expect(resolveReadableStablecoinId(PRE_LAUNCH_ID!)).toBeNull();
    expect(resolveReadableStablecoinId(SHADOW_ID!)).toBeNull();
  });

  it("resolves PSI-inclusive IDs but excludes pre-launch and frozen tracked entries", () => {
    expect(resolvePsiInclusiveStablecoinId(CANONICAL_USDT_ID)).toEqual({ canonicalId: CANONICAL_USDT_ID });
    expect(resolvePsiInclusiveStablecoinId(SHADOW_ID!)).toEqual({ canonicalId: SHADOW_ID });
    expect(resolvePsiInclusiveStablecoinId(PRE_LAUNCH_ID!)).toBeNull();
    expect(resolvePsiInclusiveStablecoinId(FROZEN_ID!)).toBeNull();
  });
});

describe("REGISTRY_BY_CMC_SLUG", () => {
  it("maps cmcSlug to meta", () => {
    expect(REGISTRY_BY_CMC_SLUG.get("jupusd")?.symbol).toBe("JUPUSD");
  });

  it("has no duplicate cmcSlugs", () => {
    const cmcSlugCount = [...TRACKED_STABLECOINS, ...SHADOW_STABLECOINS].filter(
      (stablecoin) => stablecoin.cmcSlug,
    ).length;

    expect(REGISTRY_BY_CMC_SLUG.size).toBe(cmcSlugCount);
  });

  it("skips entries without cmcSlug", () => {
    expect(REGISTRY_BY_CMC_SLUG.size).toBeLessThan(TRACKED_STABLECOINS.length);
  });
});

describe("REGISTRY_BY_GECKO_ID", () => {
  it("maps geckoId to meta", () => {
    expect(REGISTRY_BY_GECKO_ID.get("tether")?.symbol).toBe("USDT");
  });

  it("has no duplicate geckoIds", () => {
    const geckoIdCount = [...TRACKED_STABLECOINS, ...SHADOW_STABLECOINS].filter(
      (stablecoin) => stablecoin.geckoId,
    ).length;

    expect(REGISTRY_BY_GECKO_ID.size).toBe(geckoIdCount);
  });
});

describe("dead stablecoin llamaId invariant", () => {
  it("has no duplicate dead stablecoin llamaIds", () => {
    const seenDeadLlamaIds = new Set<string>();

    for (const dead of DEAD_STABLECOINS) {
      if (!dead.llamaId) {
        continue;
      }

      expect(seenDeadLlamaIds.has(dead.llamaId)).toBe(false);
      seenDeadLlamaIds.add(dead.llamaId);
    }
  });
});
