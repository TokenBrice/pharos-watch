import { describe, expect, it } from "vitest";
import {
  buildComparisonAtAGlanceRows,
  getPrimaryStaticComparisonPageForCoin,
} from "@/lib/compare-pages";

describe("compare page blacklist copy", () => {
  it("uses resolved blacklist status instead of raw metadata flags", () => {
    const page = getPrimaryStaticComparisonPageForCoin("usde-ethena");

    expect(page).not.toBeNull();

    const rows = buildComparisonAtAGlanceRows(page!);
    const blacklistRow = rows.find((row) => row.label === "Blacklist controls");

    expect(blacklistRow).toBeDefined();
    expect(blacklistRow?.left === "Upstream freeze exposure" || blacklistRow?.right === "Upstream freeze exposure").toBe(true);
  });
});
