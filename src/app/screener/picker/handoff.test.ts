import { describe, expect, it } from "vitest";
import { SCREENER_URL_SCHEMA } from "@/lib/screener-filters";
import { decodeState } from "@/lib/url-state";
import { buildScreenerUrl } from "@shared/lib/selector";
import type { SelectorOutput } from "@shared/lib/selector";
import { makeInput } from "@shared/lib/selector/__tests__/fixture";
import { buildScreenerHandoff } from "@/lib/selector-handoff";

describe("Picker → Screener URL contract", () => {
  it("decodes every emitted field through the real schema and preserves the exact shortlist", () => {
    const coinIds = ["usdc-circle", "dai-makerdao"];
    const { url } = buildScreenerUrl(
      makeInput({
        profile: "trading",
        depegTolerance: "zero",
        exitSpeed: "1h",
        custodyOk: "onchain-only",
      }),
      "/screener/",
      coinIds,
    );
    const params = new URL(url, "https://pharos.watch").searchParams;

    for (const key of params.keys()) {
      expect(SCREENER_URL_SCHEMA).toHaveProperty(key);
    }

    const decoded = decodeState(params, SCREENER_URL_SCHEMA);
    expect(decoded.coins).toEqual(coinIds);
    expect(decoded.pegScoreMin).toBe(85);
    expect(decoded.liquidityScoreMin).toBe(65);
    expect(decoded.custodyModels).toEqual(["onchain"]);
    expect(decoded.supplyMin).toBe(5_000_000);
  });

  it("shows the exact shortlist and every non-expressible gate as divergence chips", () => {
    const input = makeInput({ profile: "treasury" });
    const output = {
      input,
      recommended: [{ id: "usdc-circle" }],
      usedRelaxedFallback: true,
    } as unknown as SelectorOutput;

    const handoff = buildScreenerHandoff(output);
    expect(handoff.url).toContain("coins=usdc-circle");
    expect(handoff.filterChips).toContainEqual({ label: "Exact shortlist", value: "usdc-circle" });
    expect(handoff.filterChips).toEqual(expect.arrayContaining([
      { label: "Picker-only", value: "Active-depeg gate" },
      { label: "Picker-only", value: "Bluechip D/F exclusion" },
      { label: "Picker-only", value: "Legal uncertainty exclusion" },
      { label: "Picker-only", value: "Relaxed PegScore fallback" },
    ]));
  });
});
