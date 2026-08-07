import { describe, expect, it } from "vitest";
import { buildV9CuratedMintPostureQueue } from "../safety-score-v9/mint-posture-annotation";
import {
  V9_MINT_POSTURE_BAND_ORDER,
  V9_MINT_POSTURE_BANDS,
  resolveV9MintPostureBand,
} from "../safety-score-v9/mint-posture";

describe("V9 mint posture bands", () => {
  it("bands every derived posture except the unresolved one", () => {
    expect(resolveV9MintPostureBand("none-resolved")).toBe("hardened");
    expect(resolveV9MintPostureBand("bounded-admin")).toBe("hardened");
    expect(resolveV9MintPostureBand("partially-bounded-admin")).toBe("governed");
    expect(resolveV9MintPostureBand("unbounded-reconciled")).toBe("managed");
    expect(resolveV9MintPostureBand("concentrated-admin")).toBe("concentrated");
    expect(resolveV9MintPostureBand("unbounded-or-compromised")).toBe("exposed");
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

describe("V9 curated mint posture queue", () => {
  it("stays silent when the annotation and the derivation agree", () => {
    const queue = buildV9CuratedMintPostureQueue([
      { assetId: "agree-exact", curatedPosture: "bounded-admin", derivedPosture: "bounded-admin" },
      { assetId: "agree-band", curatedPosture: "none-resolved", derivedPosture: "bounded-admin" },
      // The curated vocabulary has no reconciled-unbounded rung, so an adverse
      // annotation over a reconciled derivation is the split, not a conflict.
      { assetId: "agree-split", curatedPosture: "unbounded-or-compromised", derivedPosture: "unbounded-reconciled" },
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
    ]);
    expect(queue.entries.map((entry) => [entry.assetId, entry.disagreement])).toEqual([
      ["a-adverse", "curated-adverse"],
      ["d-unresolved", "derived-unresolved"],
      ["m-unreviewed", "curated-unreviewed"],
      ["z-optimistic", "curated-optimistic"],
    ]);
    expect(queue.reviewedAssetCount).toBe(4);
    expect(queue.entries.every((entry) => entry.action.length > 0)).toBe(true);
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
