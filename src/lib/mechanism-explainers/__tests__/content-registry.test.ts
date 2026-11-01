import { describe, expect, it } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import { ARCHETYPE_CONTENT } from "@/lib/mechanism-explainers";

describe("mechanism explainer representative coins", () => {
  it.each(MECHANISM_ARCHETYPE_VALUES)("keeps %s examples inside the registry's archetype", (archetype) => {
    const content = ARCHETYPE_CONTENT[archetype];
    expect(content.archetype).toBe(archetype);
    for (const entry of content.representativeCoins) {
      const meta = TRACKED_META_BY_ID.get(entry.coinId);
      expect(meta, entry.coinId).toBeTruthy();
      expect(resolveMechanismArchetype(meta!, TRACKED_META_BY_ID), entry.coinId).toBe(archetype);
    }
  });
});
