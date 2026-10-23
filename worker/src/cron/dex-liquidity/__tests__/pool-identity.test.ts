import { describe, expect, it } from "vitest";
import {
  attachReviewedQuoterV2SourcePoolIdentities,
  buildDexPriceObservationIdentity,
  buildPoolIdentity,
  buildPrimaryPoolKey,
  clearKnownPoolIdentityIndex,
  countPoolIdentityKeys,
  createKnownPoolIdentityIndex,
  getIdentityDedupReason,
  registerKnownPoolExactStablecoin,
  registerKnownPoolIdentity,
} from "../pool-identity";
import { QUOTER_V2_REVIEWED_SHADOW_POOLS } from "@shared/lib/measured-execution-deployment-policies";
import type { LlamaPool } from "../types";

describe("reviewed shadow QuoterV2 source aliases", () => {
  it.each(QUOTER_V2_REVIEWED_SHADOW_POOLS)("binds only the reviewed $chain provider UUID and exact token set", (policy) => {
    const pool = {
      pool: policy.defillamaPoolId, chain: policy.chain, project: policy.protocol,
      underlyingTokens: policy.poolTokens.map((token) => token.address).reverse(),
      tvlUsd: 123_456, volumeUsd1d: 789, poolMeta: "0.01%",
    } as LlamaPool;
    attachReviewedQuoterV2SourcePoolIdentities([pool]);
    expect(pool).toMatchObject({ pool: policy.poolAddress, tvlUsd: 123_456, volumeUsd1d: 789, poolMeta: "0.01%" });
  });

  it.each(["wrong-uuid", "wrong-chain", "wrong-protocol", "wrong-token", "missing-tokens", "duplicate-token"] as const)(
    "refuses %s instead of selecting by fingerprint or symbol",
    (refusal) => {
      const policy = QUOTER_V2_REVIEWED_SHADOW_POOLS[0];
      const pool = {
        pool: policy.defillamaPoolId as string, chain: policy.chain as string, project: policy.protocol as string,
        underlyingTokens: policy.poolTokens.map((token) => token.address as string),
      } as LlamaPool;
      if (refusal === "wrong-uuid") pool.pool = "unreviewed-provider-uuid";
      if (refusal === "wrong-chain") pool.chain = "ethereum";
      if (refusal === "wrong-protocol") pool.project = "pancakeswap";
      if (refusal === "wrong-token") pool.underlyingTokens![0] = "0x0000000000000000000000000000000000000001";
      if (refusal === "missing-tokens") pool.underlyingTokens = null;
      if (refusal === "duplicate-token") pool.underlyingTokens![1] = pool.underlyingTokens![0]!;
      const original = pool.pool;
      attachReviewedQuoterV2SourcePoolIdentities([pool]);
      expect(pool.pool).toBe(original);
    },
  );

  it.each([
    { pool: undefined },
    { pool: 123 },
    { chain: undefined },
    { chain: 123 },
    { project: undefined },
    { project: 123 },
    { underlyingTokens: undefined },
    { underlyingTokens: { length: 2 } },
    { underlyingTokens: [null, null] },
  ])("leaves incomplete or malformed alias inputs unchanged: %j", (overrides) => {
    const policy = QUOTER_V2_REVIEWED_SHADOW_POOLS[0];
    const pool = {
      pool: policy.defillamaPoolId,
      chain: policy.chain,
      project: policy.protocol,
      underlyingTokens: policy.poolTokens.map((token) => token.address),
      tvlUsd: 123_456,
      ...overrides,
    } as LlamaPool;
    const original = { ...pool };
    attachReviewedQuoterV2SourcePoolIdentities([pool]);
    expect(pool).toEqual(original);
  });
});

describe("pool identity dedup", () => {
  it("keeps opaque provider deployments distinct without claiming exact physical identity", () => {
    const first = "10000000-0000-4000-8000-000000000000";
    const second = "20000000-0000-4000-8000-000000000000";
    expect(buildPrimaryPoolKey("Ethereum", first, "uniswap-v3")).toBe(`ethereum:defillama:${first}`);
    expect(buildPrimaryPoolKey("ethereum", first, "uniswap-v3")).not.toBe(buildPrimaryPoolKey("ethereum", second, "uniswap-v3"));
    expect(buildPrimaryPoolKey("ethereum", first, "uniswap-v3")).not.toBe(buildPrimaryPoolKey("base", first, "uniswap-v3"));
    expect(buildPrimaryPoolKey("ethereum", "OpaqueCase", "curve")).not.toBe(buildPrimaryPoolKey("ethereum", "opaquecase", "curve"));
    const physical = "0xabc0000000000000000000000000000000000000";
    expect(buildPrimaryPoolKey("ethereum", first, "curve", physical)).toBe(`ethereum:${physical}`);
    expect(buildPoolIdentity({ chain: "ethereum", protocol: "curve",
      poolAddressOrId: buildPrimaryPoolKey("ethereum", first, "curve"), tokenAddresses: [],
    }).exactPoolKey).toBeNull();
  });

  it("releases every identity collection after the dedup phase", () => {
    const known = createKnownPoolIdentityIndex();
    known.exactKeys.add("ethereum:0xpool");
    known.exactStablecoinIdsByKey.set("ethereum:0xpool", new Set(["usdc-circle"]));
    known.derivedKeyCounts.set("derived", 1);
    known.derivedToExactKeys.set("derived", new Set(["ethereum:0xpool"]));
    known.wildcardKeyCounts.set("wildcard", 1);
    known.wildcardToExactKeys.set("wildcard", new Set(["ethereum:0xpool"]));
    known.concreteFeeVariantKeys.set("variant", new Set(["derived"]));

    clearKnownPoolIdentityIndex(known);

    expect(known.exactKeys.size).toBe(0);
    expect(known.exactStablecoinIdsByKey.size).toBe(0);
    expect(known.derivedKeyCounts.size).toBe(0);
    expect(known.derivedToExactKeys.size).toBe(0);
    expect(known.wildcardKeyCounts.size).toBe(0);
    expect(known.wildcardToExactKeys.size).toBe(0);
    expect(known.concreteFeeVariantKeys.size).toBe(0);
  });

  it("scopes exact dedupe to the stablecoins already credited with the physical pool", () => {
    const known = createKnownPoolIdentityIndex();
    const identity = buildPoolIdentity({
      chain: "ethereum",
      protocol: "curve",
      poolAddressOrId: "0xabc0000000000000000000000000000000000000",
      tokenAddresses: [],
    });
    registerKnownPoolIdentity(known, identity);
    registerKnownPoolExactStablecoin(known, identity, "usdc-circle");

    expect(
      getIdentityDedupReason(identity, known, { derived: 0, wildcard: 0 }, { stablecoinId: "usdc-circle" }),
    ).toBe("exact");
    expect(
      getIdentityDedupReason(identity, known, { derived: 0, wildcard: 0 }, { stablecoinId: "eur0-usual" }),
    ).toBeNull();
    expect(getIdentityDedupReason(identity, known, { derived: 0, wildcard: 0 })).toBe("exact");
  });

  it("normalizes producer observation labels from the shared pool identity", () => {
    const derived = buildPoolIdentity({
      chain: "ethereum",
      protocol: "curve",
      poolAddressOrId: "opaque-provider-id",
      tokenAddresses: [
        "0xabc0000000000000000000000000000000000001",
        "0xabc0000000000000000000000000000000000002",
      ],
      poolType: "curve-stableswap",
    });

    expect(buildDexPriceObservationIdentity(derived)).toEqual({
      derivedMatchKey: derived.derivedMatchKey,
      identityConfidence: "derived_unique",
    });
  });

  it("preserves case-distinct Solana pool and token identities", () => {
    const upper = buildPoolIdentity({
      chain: "Solana",
      protocol: "raydium",
      poolAddressOrId: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
      tokenAddresses: ["MintCase", "QuoteMint"],
      poolType: "raydium-amm",
    });
    const lower = buildPoolIdentity({
      chain: "solana",
      protocol: "raydium",
      poolAddressOrId: "9j7m8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
      tokenAddresses: ["mintCase", "QuoteMint"],
      poolType: "raydium-amm",
    });

    expect(upper.exactPoolKey).not.toBe(lower.exactPoolKey);
    expect(upper.derivedMatchKey).not.toBe(lower.derivedMatchKey);
  });

  it("collapses EVM checksum variants in exact and derived identities", () => {
    const checksum = buildPoolIdentity({
      chain: "Ethereum",
      protocol: "balancer",
      poolAddressOrId: "0xAbCd000000000000000000000000000000000001",
      tokenAddresses: ["0xAbCd000000000000000000000000000000000002", "0xAbCd000000000000000000000000000000000003"],
      poolType: "balancer-weighted",
    });
    const lowercase = buildPoolIdentity({
      chain: "ethereum",
      protocol: "balancer",
      poolAddressOrId: "0xabcd000000000000000000000000000000000001",
      tokenAddresses: ["0xabcd000000000000000000000000000000000002", "0xabcd000000000000000000000000000000000003"],
      poolType: "balancer-weighted",
    });

    expect(checksum.exactPoolKey).toBe(lowercase.exactPoolKey);
    expect(checksum.derivedMatchKey).toBe(lowercase.derivedMatchKey);
  });

  it("canonicalizes exact pool ids that already include a chain prefix", () => {
    const identity = buildPoolIdentity({
      chain: "ethereum",
      protocol: "balancer",
      poolAddressOrId: "ethereum:0xabc0000000000000000000000000000000000000",
      tokenAddresses: [],
    });

    expect(identity.exactPoolKey).toBe("ethereum:0xabc0000000000000000000000000000000000000");
  });

  it("preserves asset-specific synthetic orderbook prefixes for exact dedup identity", () => {
    const identity = buildPoolIdentity({
      chain: "orderbook",
      protocol: "binance",
      poolAddressOrId: "orderbook:binance:usdt-tether",
      tokenAddresses: [],
    });

    expect(identity.exactPoolKey).toBe("orderbook:binance:usdt-tether");
    expect(identity.identitySource).toBe("native-id");
  });

  it("does not trust exchange-only orderbook ids as exact dedup identities", () => {
    const identity = buildPoolIdentity({
      chain: "orderbook",
      protocol: "binance",
      poolAddressOrId: "orderbook:binance",
      tokenAddresses: [],
    });

    expect(identity.exactPoolKey).toBeNull();
    expect(identity.identitySource).toBe("none");
  });

  it("can dedupe an identity-poor Uniswap v4 DL row against one staged exact-pool-id row", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain: "Ethereum",
        protocol: "uniswap-v4",
        poolAddressOrId: "d0c42a48-871a-4e83-9ef2-b3f60b3e0e90",
        tokenAddresses: ["0x6440f144b7e50d6a8439336510312d2f54beb01d", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
        poolType: "generic",
        isStable: true,
      }),
    );

    const incoming = buildPoolIdentity({
      chain: "ethereum",
      protocol: "uniswap-v4-ethereum",
      poolAddressOrId: "0x5d0ed52610c76d7bf729130ce7ddc0488b2f4bd0a0db1f12adbe6a32deaff893",
      tokenAddresses: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0x6440f144b7e50d6a8439336510312d2f54beb01d"],
      poolType: "cg-concentrated",
      isStable: null,
    });
    const counts = countPoolIdentityKeys([incoming]);
    expect(incoming.exactPoolKey).toBe("ethereum:0x5d0ed52610c76d7bf729130ce7ddc0488b2f4bd0a0db1f12adbe6a32deaff893");
    expect(incoming.identitySource).toBe("native-id");

    expect(
      getIdentityDedupReason(
        incoming,
        known,
        {
          derived: counts.derived.get(incoming.derivedMatchKey!) ?? 0,
          wildcard: counts.wildcard.get(incoming.optionalWildcardKey!) ?? 0,
        },
        { allowOptionalWildcard: true },
      ),
    ).toBe("derived_optional_wildcard");
  });

  it("does not wildcard-dedupe staged same-pair pools when the incoming bucket is ambiguous", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain: "ethereum",
        protocol: "uniswap-v4",
        poolAddressOrId: "d0c42a48-871a-4e83-9ef2-b3f60b3e0e90",
        tokenAddresses: ["0x6440f144b7e50d6a8439336510312d2f54beb01d", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
        poolType: "generic",
        isStable: true,
      }),
    );

    const incoming = [
      buildPoolIdentity({
        chain: "ethereum",
        protocol: "uniswap-v4-ethereum",
        poolAddressOrId: "0x5d0ed52610c76d7bf729130ce7ddc0488b2f4bd0a0db1f12adbe6a32deaff893",
        tokenAddresses: ["0x6440f144b7e50d6a8439336510312d2f54beb01d", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
        poolType: "cg-concentrated",
      }),
      buildPoolIdentity({
        chain: "ethereum",
        protocol: "uniswap-v4-ethereum",
        poolAddressOrId: "0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5",
        tokenAddresses: ["0x6440f144b7e50d6a8439336510312d2f54beb01d", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
        poolType: "cg-concentrated",
      }),
    ];
    const counts = countPoolIdentityKeys(incoming);

    expect(
      getIdentityDedupReason(
        incoming[0]!,
        known,
        {
          derived: counts.derived.get(incoming[0]!.derivedMatchKey!) ?? 0,
          wildcard: counts.wildcard.get(incoming[0]!.optionalWildcardKey!) ?? 0,
        },
        { allowOptionalWildcard: true },
      ),
    ).toBeNull();
  });

  it("dedupes an Orca DL row missing fee metadata via na-variant derived lookup", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain: "solana",
        protocol: "orca",
        poolAddressOrId: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
        tokenAddresses: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1"],
        poolType: "orca-whirlpool",
        feeTierBps: 1,
        isStable: true,
      }),
    );

    const incoming = buildPoolIdentity({
      chain: "Solana",
      protocol: "orca-dex",
      poolAddressOrId: "4f44c5d5-b1c2-4b1c-a111-123456789abc",
      tokenAddresses: ["EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", "So11111111111111111111111111111111111111112"],
      poolType: "orca-whirlpool",
      isStable: true,
    });
    const counts = countPoolIdentityKeys([incoming]);

    expect(
      getIdentityDedupReason(
        incoming,
        known,
        {
          derived: counts.derived.get(incoming.derivedMatchKey!) ?? 0,
          wildcard: counts.wildcard.get(incoming.optionalWildcardKey!) ?? 0,
        },
        { allowOptionalWildcard: true },
      ),
    ).toBe("derived_unique");
  });

  it("does not use optional wildcard dedup when the incoming pool has full optional metadata", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain: "solana",
        protocol: "orca",
        poolAddressOrId: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
        tokenAddresses: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1"],
        poolType: "orca-whirlpool",
        feeTierBps: 1,
        isStable: true,
      }),
    );

    const incoming = buildPoolIdentity({
      chain: "solana",
      protocol: "orca-dex",
      poolAddressOrId: "4f44c5d5-b1c2-4b1c-a111-123456789abc",
      tokenAddresses: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1"],
      poolType: "orca-whirlpool",
      feeTierBps: 1,
      isStable: true,
    });
    const counts = countPoolIdentityKeys([incoming]);

    expect(
      getIdentityDedupReason(
        incoming,
        known,
        {
          derived: counts.derived.get(incoming.derivedMatchKey!) ?? 0,
          wildcard: counts.wildcard.get(incoming.optionalWildcardKey!) ?? 0,
        },
        { allowOptionalWildcard: true },
      ),
    ).toBe("derived_unique");
  });

  it("does not use optional wildcard dedup when the wildcard bucket is ambiguous", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain: "solana",
        protocol: "orca",
        poolAddressOrId: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
        tokenAddresses: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1"],
        poolType: "orca-whirlpool",
        feeTierBps: 1,
        isStable: true,
      }),
    );
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain: "solana",
        protocol: "orca",
        poolAddressOrId: "8k6N7m5b4V3c2X1z9Y8w7u6T5r4e3W2q1P9o8i7u6Y5",
        tokenAddresses: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1"],
        poolType: "orca-whirlpool",
        feeTierBps: 5,
        isStable: true,
      }),
    );

    const incoming = buildPoolIdentity({
      chain: "Solana",
      protocol: "orca-dex",
      poolAddressOrId: "4f44c5d5-b1c2-4b1c-a111-123456789abc",
      tokenAddresses: ["EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", "So11111111111111111111111111111111111111112"],
      poolType: "orca-whirlpool",
      isStable: true,
    });
    const counts = countPoolIdentityKeys([incoming]);

    expect(
      getIdentityDedupReason(
        incoming,
        known,
        {
          derived: counts.derived.get(incoming.derivedMatchKey!) ?? 0,
          wildcard: counts.wildcard.get(incoming.optionalWildcardKey!) ?? 0,
        },
        { allowOptionalWildcard: true },
      ),
    ).toBeNull();
  });

  it("dedupes direct-API (fee=concrete) vs DL (fee=na) via na-variant reverse lookup", () => {
    const known = createKnownPoolIdentityIndex();
    // Known: DL row with fee=na
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain: "ethereum",
        protocol: "balancer-v3",
        poolAddressOrId: "6b6de6c7-uuid-opaque",
        tokenAddresses: ["0xusdc0000000000000000000000000000000000000", "0xusdt0000000000000000000000000000000000000"],
        poolType: "balancer-weighted",
        feeTierBps: null,
        isStable: null,
        isStableHint: true,
      }),
    );
    // Incoming: direct-API row with concrete fee
    const incoming = buildPoolIdentity({
      chain: "ethereum",
      protocol: "balancer",
      poolAddressOrId: "0xabc0000000000000000000000000000000000000",
      tokenAddresses: ["0xusdc0000000000000000000000000000000000000", "0xusdt0000000000000000000000000000000000000"],
      poolType: "balancer-stable",
      feeTierBps: 1,
      isStable: true,
    });
    const reason = getIdentityDedupReason(
      incoming,
      known,
      { derived: 1, wildcard: 1 },
      { allowOptionalWildcard: true },
    );
    expect(reason).toBe("derived_unique");
  });
});

describe("buildPoolIdentity isStableHint", () => {
  it("forces stable shape when isStableHint is true even if isStable is null", () => {
    const identity = buildPoolIdentity({
      chain: "ethereum",
      protocol: "balancer-v3",
      poolAddressOrId: "6b6de6c7-uuid-not-an-address",
      tokenAddresses: ["0xusdc0000000000000000000000000000000000000", "0xusdt0000000000000000000000000000000000000"],
      poolType: "balancer-weighted",
      isStable: null,
      isStableHint: true,
    });
    expect(identity.derivedMatchKey).toContain("|stable|");
  });
  it("leaves weighted shape when isStableHint is absent", () => {
    const identity = buildPoolIdentity({
      chain: "ethereum",
      protocol: "balancer-v3",
      poolAddressOrId: "6b6de6c7-uuid-not-an-address",
      tokenAddresses: ["0xusdc0000000000000000000000000000000000000", "0xusdt0000000000000000000000000000000000000"],
      poolType: "balancer-weighted",
      isStable: null,
    });
    expect(identity.derivedMatchKey).toContain("|weighted|");
  });
});

describe("Aero basic pool identity", () => {
  const tokens = ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"];
  const direct = (poolType: string, poolAddressOrId: string) => buildPoolIdentity({
    chain: "base", protocol: "aero-basic", poolAddressOrId, tokenAddresses: tokens, poolType, isStable: true,
  });
  // DefiLlama `aero-basic` rows have no subtype and always classify volatile.
  const defillama = buildPoolIdentity({
    chain: "base", protocol: "aero-basic", poolAddressOrId: "6a3b2c1d-uuid", tokenAddresses: [...tokens].reverse(),
    poolType: "aero-volatile", isStable: true,
  });

  const incomingCounts = () => {
    const counts = countPoolIdentityKeys([defillama]);
    return {
      derived: counts.derived.get(defillama.derivedMatchKey!) ?? 0,
      wildcard: counts.wildcard.get(defillama.optionalWildcardKey!) ?? 0,
    };
  };

  it("dedupes a DefiLlama row against the unique direct stable-factory pool", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(known, direct("aero-stable", "0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f"));
    expect(getIdentityDedupReason(defillama, known, incomingCounts())).not.toBeNull();
  });

  it("keeps DefiLlama and DexScreener observations of one pool deduping without direct rows", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(known, buildPoolIdentity({
      chain: "base", protocol: "aero", poolAddressOrId: "0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f",
      tokenAddresses: tokens, poolType: "ds-amm", isStable: null,
    }));
    expect(getIdentityDedupReason(defillama, known, incomingCounts(), { allowOptionalWildcard: true })).not.toBeNull();
  });

  it("keeps a Slipstream pool of the same pair out of the basic-pool match", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(known, direct("aero-stable", "0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f"));
    registerKnownPoolIdentity(known, buildPoolIdentity({
      chain: "base", protocol: "aero-slipstream", poolAddressOrId: "0xd448990883e3bf9cdd8ebca368a3ecf9d629aaf7",
      tokenAddresses: tokens, poolType: "aero-slipstream-1bp", feeTierBps: 1, isStable: true,
    }));
    const slipstreamDl = buildPoolIdentity({
      chain: "base", protocol: "aero-slipstream", poolAddressOrId: "7b4c-uuid", tokenAddresses: tokens,
      poolType: "aero-slipstream-5bp", isStable: true,
    });
    expect(slipstreamDl.derivedMatchKey).not.toBe(defillama.derivedMatchKey);
    expect(getIdentityDedupReason(defillama, known, incomingCounts())).not.toBeNull();
  });

  it("does not collapse when a stable and a volatile pool share the pair", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(known, direct("aero-stable", "0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f"));
    registerKnownPoolIdentity(known, direct("aero-volatile", "0x00000000000000000000000000000000000000b2"));
    expect(getIdentityDedupReason(defillama, known, incomingCounts())).toBeNull();
  });
});
