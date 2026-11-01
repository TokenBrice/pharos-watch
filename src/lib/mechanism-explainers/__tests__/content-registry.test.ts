import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("backs every credit-fund example's quarterly redemption claim with its own reviewed mechanism", () => {
    for (const entry of ARCHETYPE_CONTENT["rwa-credit-fund"].representativeCoins) {
      if (!/quarterly/i.test(entry.note)) continue;
      const mechanism = (TRACKED_META_BY_ID.get(entry.coinId)?.pegMechanism ?? "").toLowerCase();
      expect(mechanism, entry.coinId).toContain("quarter");
    }
  });

  it("keeps the OUSG note clear of the reserve mix its reviewed composition contradicts", () => {
    const note = ARCHETYPE_CONTENT.tbill.representativeCoins.find((entry) => entry.coinId === "ousg-ondo-finance")?.note;
    const { reserves } = JSON.parse(
      readFileSync(resolve(process.cwd(), "shared/data/stablecoins/domains/reserves/ousg-ondo-finance.json"), "utf8"),
    ) as { reserves: Array<{ name: string; pct: number }> };
    // State Street's sweep (≈47%) leads BUIDL (≈32%), and no FedFund holding exists.
    expect([...reserves].sort((left, right) => right.pct - left.pct)[0]?.name).toContain("State Street");
    expect(note).toBeTruthy();
    expect(note).not.toMatch(/mostly BUIDL|FedFund/i);
    expect(note).toContain("OUSGInstantManager");
  });
});
