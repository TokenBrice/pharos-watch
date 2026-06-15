import { describe, expect, it } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { LOW_VOLUME_CG_FALLBACK_IDS } from "../enrich-prices-coingecko-low-volume-pass";

describe("LOW_VOLUME_CG_FALLBACK_IDS registry invariant", () => {
  it("only references IDs present in the active stablecoin registry", () => {
    const orphaned = [...LOW_VOLUME_CG_FALLBACK_IDS].filter((id) => !ACTIVE_META_BY_ID.has(id));
    expect(orphaned).toEqual([]);
  });

  it("only references IDs that have a configured geckoId", () => {
    const missingGeckoId = [...LOW_VOLUME_CG_FALLBACK_IDS].filter((id) => {
      const meta = ACTIVE_META_BY_ID.get(id);
      return !(typeof meta?.geckoId === "string" && meta.geckoId.length > 0);
    });
    expect(missingGeckoId).toEqual([]);
  });
});
