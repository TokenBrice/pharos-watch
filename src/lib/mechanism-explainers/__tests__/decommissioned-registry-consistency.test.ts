import { describe, expect, it } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { FROZEN_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { ARCHETYPE_CONTENT } from "../index";

describe("decommissioned mechanism rows", () => {
  it("uses the registry death date for every registry-backed entry", () => {
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      for (const item of ARCHETYPE_CONTENT[archetype].decommissioned ?? []) {
        if (!item.coinId) continue;
        const coin = FROZEN_META_BY_ID.get(item.coinId);
        if (!coin) continue;
        expect(item.date, `${archetype}/${item.name}`).toBe(coin.obituary?.deathDate);
      }
    }
  });
});
