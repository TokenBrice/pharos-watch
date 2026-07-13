import { describe, expect, it } from "vitest";
import {
  buildPoolIdentity,
  countPoolIdentityKeys,
  createKnownPoolIdentityIndex,
  getIdentityDedupReason,
  registerKnownPoolIdentity,
} from "../pool-identity";

describe("pool identity dedup", () => {
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

  it("dedupes DL (fee=na) vs direct-API (fee=1) via the na-variant secondary lookup", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain: "ethereum",
        protocol: "balancer",
        poolAddressOrId: "0xabc0000000000000000000000000000000000000",
        tokenAddresses: ["0xusdc0000000000000000000000000000000000000", "0xusdt0000000000000000000000000000000000000"],
        poolType: "balancer-stable",
        feeTierBps: 1,
        isStable: true,
      }),
    );
    const incoming = buildPoolIdentity({
      chain: "ethereum",
      protocol: "balancer-v3",
      poolAddressOrId: "6b6de6c7-uuid-opaque",
      tokenAddresses: ["0xusdc0000000000000000000000000000000000000", "0xusdt0000000000000000000000000000000000000"],
      poolType: "balancer-weighted",
      feeTierBps: null,
      isStable: null,
      isStableHint: true,
    });
    const reason = getIdentityDedupReason(
      incoming,
      known,
      { derived: 1, wildcard: 1 },
      { allowOptionalWildcard: true },
    );
    expect(reason).not.toBeNull();
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
