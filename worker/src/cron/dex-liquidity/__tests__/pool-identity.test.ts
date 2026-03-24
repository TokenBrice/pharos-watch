import { describe, expect, it } from "vitest";
import {
  buildPoolIdentity,
  countPoolIdentityKeys,
  createKnownPoolIdentityIndex,
  getIdentityDedupReason,
  registerKnownPoolIdentity,
} from "../pool-identity";

describe("pool identity dedup", () => {
  it("uses optional wildcard dedup for an Orca DL row missing fee metadata", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(known, buildPoolIdentity({
      chain: "solana",
      protocol: "orca",
      poolAddressOrId: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
      tokenAddresses: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1"],
      poolType: "orca-whirlpool",
      feeTierBps: 1,
      isStable: true,
    }));

    const incoming = buildPoolIdentity({
      chain: "Solana",
      protocol: "orca-dex",
      poolAddressOrId: "4f44c5d5-b1c2-4b1c-a111-123456789abc",
      tokenAddresses: ["EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", "So11111111111111111111111111111111111111112"],
      poolType: "orca-whirlpool",
      isStable: true,
    });
    const counts = countPoolIdentityKeys([incoming]);

    expect(getIdentityDedupReason(
      incoming,
      known,
      {
        derived: counts.derived.get(incoming.derivedMatchKey!) ?? 0,
        wildcard: counts.wildcard.get(incoming.optionalWildcardKey!) ?? 0,
      },
      { allowOptionalWildcard: true },
    )).toBe("derived_optional_wildcard");
  });

  it("does not use optional wildcard dedup when the incoming pool has full optional metadata", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(known, buildPoolIdentity({
      chain: "solana",
      protocol: "orca",
      poolAddressOrId: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
      tokenAddresses: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1"],
      poolType: "orca-whirlpool",
      feeTierBps: 1,
      isStable: true,
    }));

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

    expect(getIdentityDedupReason(
      incoming,
      known,
      {
        derived: counts.derived.get(incoming.derivedMatchKey!) ?? 0,
        wildcard: counts.wildcard.get(incoming.optionalWildcardKey!) ?? 0,
      },
      { allowOptionalWildcard: true },
    )).toBe("derived_unique");
  });

  it("does not use optional wildcard dedup when the wildcard bucket is ambiguous", () => {
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(known, buildPoolIdentity({
      chain: "solana",
      protocol: "orca",
      poolAddressOrId: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
      tokenAddresses: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1"],
      poolType: "orca-whirlpool",
      feeTierBps: 1,
      isStable: true,
    }));
    registerKnownPoolIdentity(known, buildPoolIdentity({
      chain: "solana",
      protocol: "orca",
      poolAddressOrId: "8k6N7m5b4V3c2X1z9Y8w7u6T5r4e3W2q1P9o8i7u6Y5",
      tokenAddresses: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1"],
      poolType: "orca-whirlpool",
      feeTierBps: 5,
      isStable: true,
    }));

    const incoming = buildPoolIdentity({
      chain: "Solana",
      protocol: "orca-dex",
      poolAddressOrId: "4f44c5d5-b1c2-4b1c-a111-123456789abc",
      tokenAddresses: ["EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", "So11111111111111111111111111111111111111112"],
      poolType: "orca-whirlpool",
      isStable: true,
    });
    const counts = countPoolIdentityKeys([incoming]);

    expect(getIdentityDedupReason(
      incoming,
      known,
      {
        derived: counts.derived.get(incoming.derivedMatchKey!) ?? 0,
        wildcard: counts.wildcard.get(incoming.optionalWildcardKey!) ?? 0,
      },
      { allowOptionalWildcard: true },
    )).toBeNull();
  });
});
