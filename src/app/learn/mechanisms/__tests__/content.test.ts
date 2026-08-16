import { describe, expect, it } from "vitest";
import { MECHANISM_ARCHETYPE_LABELS, MECHANISM_ARCHETYPE_ONE_LINERS } from "@shared/lib/classification";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { ARCHETYPE_CONTENT } from "@/lib/mechanism-explainers";

describe("mechanism explainer content", () => {
  it("fully wires editorial content and representative coins for every archetype", () => {
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      const content = ARCHETYPE_CONTENT[archetype];
      expect(MECHANISM_ARCHETYPE_LABELS[archetype].trim(), `${archetype} label`).not.toBe("");
      expect(MECHANISM_ARCHETYPE_ONE_LINERS[archetype].trim(), `${archetype} one-liner`).not.toBe("");
      expect(content.headline.trim(), `${archetype} headline`).not.toBe("");
      expect(content.headline, `${archetype} headline`).not.toMatch(/^\s*stub/i);
      expect(content.subtitle.trim(), `${archetype} subtitle`).not.toBe("");
      expect(content.subtitle, `${archetype} subtitle`).not.toMatch(/^\s*stub/i);
      expect(content.representativeCoins.length, `${archetype} representatives`).toBeGreaterThan(0);
      for (const coin of content.representativeCoins) {
        expect(TRACKED_META_BY_ID.has(coin.coinId), `${archetype}: ${coin.coinId}`).toBe(true);
      }
    }
  });
});
