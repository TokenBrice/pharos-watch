import { describe, expect, it } from "vitest";
import { MINT_AUTHORITY_POSTURE_VALUES } from "../../types/core";
import { buildV9CuratedMintPostureQueue } from "../safety-score-v9/mint-posture-annotation";
import {
  V9_MINT_POSTURE_BAND_ORDER,
  V9_MINT_POSTURE_BANDS,
  isFragileMintPosture,
  isNoPrivilegedMintChainPosture,
  isNoPrivilegedMintPosture,
  isUnboundedMintPosture,
  resolveV9MintPostureBand,
} from "../safety-score-v9/mint-posture";

describe("V9 mint posture bands", () => {
  it("bands every derived posture except the unresolved one", () => {
    expect(resolveV9MintPostureBand("none-resolved")).toBe("hardened");
    expect(resolveV9MintPostureBand("bounded-admin")).toBe("hardened");
    expect(resolveV9MintPostureBand("partially-bounded-admin")).toBe("governed");
    expect(resolveV9MintPostureBand("unbounded-reconciled")).toBe("managed");
    expect(resolveV9MintPostureBand("concentrated-admin")).toBe("concentrated");
    expect(resolveV9MintPostureBand("collateral-gated")).toBe("concentrated");
    expect(resolveV9MintPostureBand("unbounded-or-compromised")).toBe("exposed");
    expect(resolveV9MintPostureBand("unbounded-reconciliation-unknown")).toBe("exposed");
    expect(resolveV9MintPostureBand("unknown")).toBeNull();
  });

  it("renders NR rather than guessing for absent or unrecognized postures", () => {
    expect(resolveV9MintPostureBand(null)).toBeNull();
    expect(resolveV9MintPostureBand(undefined)).toBeNull();
    expect(resolveV9MintPostureBand("a-posture-from-a-newer-publication")).toBeNull();
  });

  it("keeps the band order and label table in sync", () => {
    expect([...V9_MINT_POSTURE_BAND_ORDER].sort()).toEqual(Object.keys(V9_MINT_POSTURE_BANDS).sort());
  });
});

describe("mint posture predicates", () => {
  // These predicates are the single source of posture set membership for every
  // engine (V9 bands, DDR structural class, DDR K1/R1). The exhaustiveness case
  // below is deliberately total over `MINT_AUTHORITY_POSTURE_VALUES`, so adding
  // a new posture fails here first and forces an explicit set decision rather
  // than a silent fall-through at each consumer.
  const expected: Record<
    (typeof MINT_AUTHORITY_POSTURE_VALUES)[number],
    { noPrivilegedMint: boolean; noPrivilegedMintChain: boolean; fragile: boolean; unbounded: boolean }
  > = {
    "none-resolved": { noPrivilegedMint: true, noPrivilegedMintChain: true, fragile: false, unbounded: false },
    "none-resolved-mint": { noPrivilegedMint: true, noPrivilegedMintChain: false, fragile: false, unbounded: false },
    "bounded-admin": { noPrivilegedMint: false, noPrivilegedMintChain: false, fragile: false, unbounded: false },
    "partially-bounded-admin": {
      noPrivilegedMint: false,
      noPrivilegedMintChain: false,
      fragile: false,
      unbounded: false,
    },
    "unbounded-reconciled": { noPrivilegedMint: false, noPrivilegedMintChain: false, fragile: true, unbounded: true },
    "concentrated-admin": { noPrivilegedMint: false, noPrivilegedMintChain: false, fragile: true, unbounded: false },
    "collateral-gated": { noPrivilegedMint: false, noPrivilegedMintChain: false, fragile: true, unbounded: false },
    "unbounded-or-compromised": {
      noPrivilegedMint: false,
      noPrivilegedMintChain: false,
      fragile: true,
      unbounded: true,
    },
    "unbounded-reconciliation-unknown": {
      noPrivilegedMint: false,
      noPrivilegedMintChain: false,
      fragile: true,
      unbounded: true,
    },
    unknown: { noPrivilegedMint: false, noPrivilegedMintChain: false, fragile: false, unbounded: false },
  };

  it("classifies every posture in the curated vocabulary", () => {
    for (const posture of MINT_AUTHORITY_POSTURE_VALUES) {
      expect({
        posture,
        noPrivilegedMint: isNoPrivilegedMintPosture(posture),
        noPrivilegedMintChain: isNoPrivilegedMintChainPosture(posture),
        fragile: isFragileMintPosture(posture),
        unbounded: isUnboundedMintPosture(posture),
      }).toEqual({ posture, ...expected[posture] });
    }
  });

  it("answers false for absent and unrecognized postures", () => {
    for (const value of [null, undefined, "", "future-posture"]) {
      expect(isNoPrivilegedMintPosture(value)).toBe(false);
      expect(isNoPrivilegedMintChainPosture(value)).toBe(false);
      expect(isFragileMintPosture(value)).toBe(false);
      expect(isUnboundedMintPosture(value)).toBe(false);
    }
  });

  it("keeps the strict subsets strict", () => {
    for (const posture of MINT_AUTHORITY_POSTURE_VALUES) {
      if (isNoPrivilegedMintChainPosture(posture)) expect(isNoPrivilegedMintPosture(posture)).toBe(true);
      if (isUnboundedMintPosture(posture)) expect(isFragileMintPosture(posture)).toBe(true);
      expect(isNoPrivilegedMintPosture(posture) && isFragileMintPosture(posture)).toBe(false);
    }
  });
});

describe("V9 curated mint posture queue", () => {
  it("stays silent when the annotation and the derivation agree", () => {
    const queue = buildV9CuratedMintPostureQueue([
      { assetId: "agree-exact", curatedPosture: "bounded-admin", derivedPosture: "bounded-admin" },
      { assetId: "agree-band", curatedPosture: "none-resolved", derivedPosture: "bounded-admin" },
      { assetId: "agree-reconciled", curatedPosture: "unbounded-reconciled", derivedPosture: "unbounded-reconciled" },
      { assetId: "neither", curatedPosture: "unknown", derivedPosture: "unknown" },
    ]);
    expect(queue.entries).toEqual([]);
  });

  it("classifies each disagreement direction and orders entries by asset id", () => {
    const queue = buildV9CuratedMintPostureQueue([
      { assetId: "z-optimistic", curatedPosture: "bounded-admin", derivedPosture: "unbounded-or-compromised" },
      { assetId: "a-adverse", curatedPosture: "concentrated-admin", derivedPosture: "partially-bounded-admin" },
      { assetId: "m-unreviewed", curatedPosture: "unknown", derivedPosture: "bounded-admin" },
      { assetId: "d-unresolved", curatedPosture: "bounded-admin", derivedPosture: "unknown" },
      // No longer suppressed: the curated vocabulary can now express the
      // reconciled rung, so a stale adverse annotation over it is a real
      // curation item.
      { assetId: "b-stale-adverse", curatedPosture: "unbounded-or-compromised", derivedPosture: "unbounded-reconciled" },
    ]);
    expect(queue.entries.map((entry) => [entry.assetId, entry.disagreement])).toEqual([
      ["a-adverse", "curated-adverse"],
      ["b-stale-adverse", "curated-adverse"],
      ["d-unresolved", "derived-unresolved"],
      ["m-unreviewed", "curated-unreviewed"],
      ["z-optimistic", "curated-optimistic"],
    ]);
    expect(queue.reviewedAssetCount).toBe(5);
    expect(queue.entries.every((entry) => entry.action.length > 0)).toBe(true);
  });

  it("buckets NR cards instead of counting them as derived-unresolved", () => {
    const queue = buildV9CuratedMintPostureQueue([
      { assetId: "z-nr", curatedPosture: "bounded-admin", derivedPosture: null, publishesBreakdowns: false },
      { assetId: "a-nr", curatedPosture: "unknown", derivedPosture: null, publishesBreakdowns: false },
      // Same absent derivation, but the card *is* rated: still a real disagreement.
      { assetId: "rated-unresolved", curatedPosture: "bounded-admin", derivedPosture: null },
    ]);
    expect(queue.nrCards).toEqual(["a-nr", "z-nr"]);
    expect(queue.entries.map((entry) => [entry.assetId, entry.disagreement])).toEqual([
      ["rated-unresolved", "derived-unresolved"],
    ]);
  });

  it("digests its content so two runs over one publication are byte-identical", () => {
    const inputs = [
      { assetId: "a", curatedPosture: "bounded-admin" as const, derivedPosture: "concentrated-admin" },
    ];
    expect(buildV9CuratedMintPostureQueue(inputs).queueDigest).toBe(
      buildV9CuratedMintPostureQueue(inputs).queueDigest,
    );
    expect(
      buildV9CuratedMintPostureQueue([
        { assetId: "a", curatedPosture: "bounded-admin", derivedPosture: "unbounded-or-compromised" },
      ]).queueDigest,
    ).not.toBe(buildV9CuratedMintPostureQueue(inputs).queueDigest);
  });
});
