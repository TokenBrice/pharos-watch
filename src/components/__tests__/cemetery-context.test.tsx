import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CauseOfDeath } from "@shared/lib/cause-of-death";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import { CemeteryContext } from "@/components/cemetery/cemetery-context";
import { buildCemeteryStats } from "@/lib/cemetery-stats";

vi.mock("next/link", async () => {
  // Vitest hoists this factory, so the mock helper must load within that boundary.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

function entry(
  id: string,
  causeOfDeath: CauseOfDeath,
  deathDate: string,
  overrides: Partial<CemeteryEntry> = {},
): CemeteryEntry {
  return {
    id,
    name: `Coin ${id}`,
    symbol: id.toUpperCase(),
    pegCurrency: "USD",
    causeOfDeath,
    deathDate,
    peakMcap: 10_000_000,
    obituary: "Obituary.",
    sourceUrl: "https://example.com/",
    sourceLabel: "Example",
    ...overrides,
  };
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
}

// 2018 and 2021–2022 have records; 2019–2020 are empty; 2022 is the partial as-of year.
const FIXTURE: CemeteryEntry[] = [
  entry("a", "algorithmic-failure", "2018-03", { mechanismArchetype: "algorithmic" }),
  entry("b", "abandoned", "2021-06", { peakMcap: undefined, mechanismArchetype: "cdp" }),
  entry("c", "abandoned", "2021-09-14", { mechanismArchetype: "cdp" }),
  entry("d", "counterparty-failure", "2022-02", { archivedDataAvailable: true }),
  entry("e", "abandoned", "2022-05-02", { archivedDataAvailable: true, peakMcap: undefined }),
  entry("f", "regulatory", "2022-07", { mechanismArchetype: "fiat-cash" }),
];

function renderContext(entries: CemeteryEntry[] = FIXTURE) {
  return renderToStaticMarkup(<CemeteryContext stats={buildCemeteryStats(entries)} caseStudies={[]} />);
}

describe("CemeteryContext", () => {
  it("templates route, precision, peak and catalog figures from the stats", () => {
    const body = text(renderContext());
    expect(body).toContain("Tracked, then frozen (2)");
    expect(body).toContain("Curated (4)");
    expect(body).toContain("precise to the day for 2 records and to the month for 4");
    expect(body).toContain("2 of 6 not recorded, never counted as zero");
    expect(body).toContain("nothing is recorded for 2019–2020");
    expect(body).toContain("2 of the 3 records in 2022 so far are coins Pharos tracked live");
  });
});
