import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { formatCurrency } from "@shared/lib/format";
import {
  EDITORIAL_TITLES,
  getObituaryLead,
} from "@/lib/cemetery-editorial";

function entry(id: string) {
  const found = CEMETERY_ENTRIES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing cemetery entry ${id}`);
  return found;
}

describe("obituary previews on real records", () => {
  it("closes IRON's lead on the quoted sentence without adding a stop", () => {
    expect(getObituaryLead(entry("iron-iron-2021-06").obituary)).toBe("Dubbed crypto's \"first large-scale bank run.\"");
  });
});

describe("EDITORIAL_TITLES", () => {
  it("states no UST figure other than its recorded peak", () => {
    const ust = entry("ust-terrausd-2022-05");
    const title = EDITORIAL_TITLES["ust-terrausd-2022-05"];
    expect(ust.peakMcap).toBeDefined();
    const peak = formatCurrency(ust.peakMcap ?? Number.NaN, 1);
    const figures = title.match(/\$?\d[\d.,]*\s*(?:[KMBT]\b|thousand|million|billion|trillion)?/gi) ?? [];
    for (const figure of figures) {
      expect(peak).toContain(figure.replace(/\s+/g, ""));
    }
    expect(title).not.toMatch(/\$?40\s*(?:B\b|billion)/i);
  });
});
