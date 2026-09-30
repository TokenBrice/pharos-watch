import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CauseOfDeath } from "@shared/lib/cause-of-death";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import {
  buildCemeteryCaseStudyLinks,
  CEMETERY_INCLUSION_RULE,
  CEMETERY_PRIMARY_CAUSE_RULE,
  CemeteryContext,
} from "@/components/cemetery/cemetery-context";
import type { CaseStudyClientSummary } from "@/lib/case-study-client-index";
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
  it("anchors the section at #methodology", () => {
    expect(renderContext()).toMatch(/<section[^>]*id="methodology"/);
  });

  it("prints the owner-approved inclusion and primary-cause rules from their single constants", () => {
    const body = text(renderContext());
    expect(body).toContain(CEMETERY_INCLUSION_RULE);
    expect(body).toContain(CEMETERY_PRIMARY_CAUSE_RULE);
  });

  it("templates route, precision, peak and catalog figures from the stats", () => {
    const body = text(renderContext());
    expect(body).toContain("Tracked, then frozen (2)");
    expect(body).toContain("Curated (4)");
    expect(body).toContain("precise to the day for 2 records and to the month for 4");
    expect(body).toContain("2 of 6 not recorded, never counted as zero");
    expect(body).toContain("nothing is recorded for 2019–2020");
    expect(body).toContain("2 of the 3 records in 2022 so far are coins Pharos tracked live");
  });

  it("links the lifecycle rules and the depeg tracker instead of restating them", () => {
    const html = renderContext();
    expect(html).toContain('href="/methodology/#lifecycle-phases-methodology"');
    expect(html).toContain('href="/depeg/"');
  });

  it("reports unmapped mechanism records only while some remain", () => {
    expect(text(renderContext())).toContain("2 of 6 records have no mechanism link yet");

    const fullyMapped = FIXTURE.map((row) => ({ ...row, mechanismArchetype: row.mechanismArchetype ?? "tbill" }));
    expect(text(renderContext(fullyMapped))).not.toContain("no mechanism link");
  });

  it("lists explainers with at least one linked death, most deaths first, ties in archetype order", () => {
    const html = renderContext();
    const hrefs = [...html.matchAll(/href="(\/learn\/mechanisms\/[^"]+)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual([
      "/learn/mechanisms/cdp/",
      "/learn/mechanisms/fiat-cash/",
      "/learn/mechanisms/algorithmic/",
    ]);
    const body = text(html);
    expect(body).toContain("CDP Stablecoins, Explained");
    expect(body).toContain("2 linked deaths");
    expect(body).toContain("1 linked death");
  });

  it("names holder exit routes only when those records carry a recorded peak", () => {
    expect(text(renderContext())).not.toContain("redemption routes");

    const withRoutes = [
      ...FIXTURE,
      entry("busd-binance-usd-2023-02", "regulatory", "2023-02", { symbol: "BUSD" }),
      entry("fei-fei-usd-2022-08", "abandoned", "2022-08", { symbol: "FEI" }),
      entry("eurt-euro-tether-2024-11", "regulatory", "2024-11", { symbol: "EURT", pegCurrency: "EUR" }),
    ];
    expect(text(renderContext(withRoutes))).toContain("BUSD holders were converted, and FEI and EURT had redemption routes.");
  });

  it("renders case studies in the order given, with symbol and death month", () => {
    const html = renderToStaticMarkup(
      <CemeteryContext
        stats={buildCemeteryStats(FIXTURE)}
        caseStudies={[
          { id: "e", slug: "e-study", title: "Study E", symbol: "E", deathDate: "2022-05-02" },
          { id: "a", slug: "a-study", title: "Study A", symbol: "A", deathDate: "2018-03" },
        ]}
      />,
    );
    const hrefs = [...html.matchAll(/href="(\/learn\/case-studies\/[^"]+)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual(["/learn/case-studies/e-study/", "/learn/case-studies/a-study/"]);
    expect(text(html)).toContain("E · May 2022");
  });
});

describe("buildCemeteryCaseStudyLinks", () => {
  const index: Record<string, CaseStudyClientSummary> = {
    a: { slug: "a-study", title: "Study A", outcome: "died" },
    c: { slug: "c-study", title: "Study C", outcome: "died" },
    f: { slug: "f-study", title: "Study F", outcome: "died" },
    missing: { slug: "missing-study", title: "Study Missing", outcome: "died" },
  };

  it("keeps only records with a case study, newest death first", () => {
    const links = buildCemeteryCaseStudyLinks(FIXTURE, index);
    expect(links.map((link) => link.id)).toEqual(["f", "c", "a"]);
    expect(links[0]).toEqual({ id: "f", slug: "f-study", title: "Study F", symbol: "F", deathDate: "2022-07" });
  });

  it("orders a day-precise death after a month-precise one in the same month, per the cemetery sort", () => {
    const sameMonth = [entry("m", "abandoned", "2024-03"), entry("d", "abandoned", "2024-03-20")];
    const links = buildCemeteryCaseStudyLinks(sameMonth, {
      m: { slug: "m", title: "M", outcome: "died" },
      d: { slug: "d", title: "D", outcome: "died" },
    });
    expect(links.map((link) => link.id)).toEqual(["d", "m"]);
  });
});
