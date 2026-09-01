import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { scanEditorialText } from "@shared/lib/editorial-style";

import {
  EDITORIAL_SURFACE_REGISTRY,
  hasEditorialPolicyImpact,
  validateEditorialSurfaceCoverage,
  type EditorialSurfaceEntry,
} from "../lib/editorial-surface-registry";
import {
  extractUnitsForSurface,
  type ExtractedEditorialUnit,
} from "../lib/editorial-extractors";

function findingsForSurface(
  surface: EditorialSurfaceEntry,
  units: readonly ExtractedEditorialUnit[],
) {
  return units.flatMap((unit) => scanEditorialText(unit.text, {
    register: surface.register,
    field: unit.field,
    ownership: unit.ownership,
    exemptions: unit.exemptions,
  }));
}

describe("editorial extractors and surface registry", () => {
  it("preserves signed mathematical-minus amounts through JSON extraction", () => {
    const surface = EDITORIAL_SURFACE_REGISTRY.find((candidate) => candidate.id === "annotations");
    if (!surface) throw new Error("annotations surface is missing");
    const source = JSON.stringify([{
      date: "2026-09-01",
      kind: "metric",
      label: "STRC drawdown: apxUSD depeg low ~$0.89 (−1,059 bps), unresolved",
      note: "Signed values: −5%, −0.3bps, − 5%, −$5M, − $5M, −EUR5M.",
    }]);
    const units = extractUnitsForSurface(surface, "shared/data/annotations/coins/fixture.json", source);
    const findings = findingsForSurface(surface, units);

    expect(units.length).toBeGreaterThan(0);
    expect(findings.filter((finding) => finding.ruleId === "no-minus-as-dash")).toEqual([]);

    const clauseSource = JSON.stringify([{
      date: "2026-09-01",
      kind: "metric",
      label: "word − word",
    }]);
    const clauseUnits = extractUnitsForSurface(surface, "shared/data/annotations/coins/fixture.json", clauseSource);
    expect(findingsForSurface(surface, clauseUnits).filter((finding) => finding.ruleId === "no-minus-as-dash")).toHaveLength(1);
  });

  it("extracts metadata and leads from the current client-page factory", () => {
    const surface = EDITORIAL_SURFACE_REGISTRY.find((candidate) => candidate.id === "page-metadata");
    if (!surface) throw new Error("page-metadata surface is missing");
    const source = readFileSync("src/app/alt-pegs/page.tsx", "utf8");
    const units = extractUnitsForSurface(surface, "src/app/alt-pegs/page.tsx", source);
    const fields = units.map((unit) => unit.field);

    expect(units.length).toBeGreaterThan(0);
    expect(fields).toContain("title");
    expect(fields).toContain("leadParagraphs");
  });

  it("splits current digest records from historical records", () => {
    const source = JSON.stringify([
      { date: "2026-09-01", digestType: "daily", title: "Daily now", text: "Daily now text", extended: "Daily now extended" },
      { date: "2026-08-31-weekly", digestType: "weekly", title: "Weekly now", text: "Weekly now text", extended: "Weekly now extended" },
      { date: "2026-08-30", digestType: "daily", title: "Daily old", text: "Daily old text", extended: "Daily old extended" },
      { date: "2026-08-24-weekly", digestType: "weekly", title: "Weekly old", text: "Weekly old text", extended: "Weekly old extended" },
    ]);
    const daily = EDITORIAL_SURFACE_REGISTRY.find((candidate) => candidate.id === "daily-digests");
    const weekly = EDITORIAL_SURFACE_REGISTRY.find((candidate) => candidate.id === "weekly-digests");
    const historical = EDITORIAL_SURFACE_REGISTRY.find((candidate) => candidate.id === "historical-digests");
    if (!daily || !weekly || !historical) throw new Error("digest surfaces are incomplete");

    const dailyTexts = extractUnitsForSurface(daily, "data/digests.json", source).map((unit) => unit.text.trim());
    const weeklyTexts = extractUnitsForSurface(weekly, "data/digests.json", source).map((unit) => unit.text.trim());
    const historicalTexts = extractUnitsForSurface(historical, "data/digests.json", source).map((unit) => unit.text.trim());

    expect(dailyTexts).toEqual(["Daily now", "Daily now text", "Daily now extended"]);
    expect(weeklyTexts).toEqual(["Weekly now", "Weekly now text", "Weekly now extended"]);
    expect(historicalTexts).toEqual([
      "Daily old",
      "Daily old text",
      "Daily old extended",
      "Weekly old",
      "Weekly old text",
      "Weekly old extended",
    ]);
  });

  it("rejects a committed surface that extracted no units", () => {
    const committed = EDITORIAL_SURFACE_REGISTRY.find((surface) => surface.id === "page-metadata");
    const historical = EDITORIAL_SURFACE_REGISTRY.find((surface) => surface.id === "historical-digests");
    if (!committed || !historical) throw new Error("coverage fixture surfaces are missing");
    const registry = [committed, historical];

    expect(() => validateEditorialSurfaceCoverage(registry, new Map())).toThrow(/page-metadata/);
    expect(() => validateEditorialSurfaceCoverage(registry, new Map([[committed.id, 1]]))).not.toThrow();
  });

  it("selects the editorial policy test when gate machinery changes", () => {
    expect(hasEditorialPolicyImpact([
      "scripts/lib/editorial-surface-registry.ts",
      "scripts/lib/editorial-extractors.ts",
      "scripts/lib/editorial-baseline.ts",
      "scripts/maintenance/generate-editorial-baseline.ts",
      "scripts/lib/editorial-gate.ts",
      "shared/lib/editorial-style.ts",
      "shared/lib/editorial-style.generated.ts",
    ])).toBe(true);
    expect(hasEditorialPolicyImpact(["src/components/unrelated.tsx"])).toBe(false);
  });
});
