import { describe, expect, it, vi } from "vitest";

const mockGetSnapshotSafetyAssessment = vi.hoisted(() =>
  vi.fn<(stablecoinId: string) => { grade: string; score: number | null; bucket: string } | null>(),
);
vi.mock("@/lib/safety-grade-snapshot", () => ({
  getSnapshotSafetyAssessment: mockGetSnapshotSafetyAssessment,
}));
vi.mock("@/lib/datasets/public-dataset-current", () => ({
  PUBLIC_DATASET_CURRENT_DATE: "2026-10-19",
}));

mockGetSnapshotSafetyAssessment.mockImplementation((id) => {
  if (id === "usdt-tether") return { grade: "A-", score: 81, bucket: "safe" };
  if (id === "usdc-circle") return { grade: "A+", score: 88, bucket: "safe" };
  if (id === "usdg-paxos") return { grade: "B", score: 73, bucket: "middle" };
  return null;
});

const {
  STATIC_COMPARISON_PAGE_BY_SLUG,
  STATIC_COMPARISON_PAGES,
  buildComparisonAtAGlanceRows,
  buildComparisonFaqItems,
  buildComparisonResearchLinks,
  buildComparisonSnippetAnswer,
  buildComparisonTitle,
} = await import("@/lib/compare-pages");

function getPage(slug: string) {
  const page = STATIC_COMPARISON_PAGE_BY_SLUG.get(slug);
  if (!page) throw new Error(`missing compare page ${slug}`);
  return page;
}

describe("static comparison metadata", () => {
  it("uses the Safety Score title and a shorter fallback past the budget", () => {
    expect(getPage("usdt-tether-vs-usdc-circle").title).toBe("USDT vs USDC: Safety Scores, Reserves & Risk");
    expect(buildComparisonTitle("LONGSYMBOL vs OTHERLONGSYM")).toBe("LONGSYMBOL vs OTHERLONGSYM: Safety Scores & Risk");
    for (const page of STATIC_COMPARISON_PAGES) {
      expect(page.title).not.toMatch(/[‒-―]/);
      expect(`${page.title} | Pharos`.length).toBeLessThanOrEqual(62);
    }
  });

  it("puts both dated grades in the description", () => {
    expect(getPage("usdt-tether-vs-usdc-circle").description).toBe(
      "Tether (USDT, A- 81/100) vs USD Coin (USDC, A+ 88/100), Safety Scores as of 2026-10-19: reserves, redemption, freeze controls and chain reach.",
    );
  });

  it("falls back to the structural description when a grade is missing, never printing N/A", () => {
    const description = getPage("usdt-tether-vs-usde-ethena").description;
    expect(description).toMatch(/^USDT vs USDe comparison:/);
    expect(description).not.toContain("N/A");
    expect(description).not.toContain("/100");
  });

  it("names each coin and ticker as a profile destination in the research list", () => {
    expect(buildComparisonResearchLinks(getPage("usdt-tether-vs-usdc-circle")).slice(0, 2)).toEqual([
      { href: "/stablecoin/usdt-tether/", label: "Tether (USDT) profile" },
      { href: "/stablecoin/usdc-circle/", label: "USD Coin (USDC) profile" },
    ]);
  });
});

describe("static comparison brief", () => {
  it("cites both dated grades in the short answer and keeps the caveat", () => {
    const answer = buildComparisonSnippetAnswer(getPage("usdt-tether-vs-usdc-circle"));
    expect(answer.answer).toMatch(
      /^In the Pharos Safety Score release of 2026-10-19, USDT held an A- Safety Score grade \(81\/100\) and USDC held an A\+ Safety Score grade \(88\/100\)\. There is no honest static answer/,
    );
    expect(answer.caveat).toContain("can change after this static brief is generated");
  });

  it("appends the grades to curated editorial answers", () => {
    const page = getPage("usdc-circle-vs-usdg-paxos");
    const answer = buildComparisonSnippetAnswer(page);
    expect(answer.answer.startsWith(page.editorial!.answer)).toBe(true);
    expect(answer.answer).toContain("USDG held a B Safety Score grade (73/100)");
    expect(answer.caveat).toContain("does not rank either token as categorically safer");
    expect(buildComparisonFaqItems(page)[0].answer).toBe(answer.answer);
  });

  it("adds a dated Safety Score row only when both grades exist", () => {
    expect(buildComparisonAtAGlanceRows(getPage("usdt-tether-vs-usdc-circle"))[0]).toEqual({
      label: "Safety Score (as of 2026-10-19)",
      left: "A- 81/100",
      right: "A+ 88/100",
    });
    expect(
      buildComparisonAtAGlanceRows(getPage("usdt-tether-vs-usde-ethena")).some((row) => row.label.startsWith("Safety Score")),
    ).toBe(false);
  });

  it("mirrors the grades in the safety FAQ answer", () => {
    const safetyFaq = buildComparisonFaqItems(getPage("usdt-tether-vs-usdc-circle"))[1];
    expect(safetyFaq.question).toBe("Which is safer: USDT or USDC?");
    expect(safetyFaq.answer).toMatch(/^In the Pharos Safety Score release of 2026-10-19, USDT held an A- /);
    expect(safetyFaq.answer).toContain("Safety is not decided by ticker alone.");
    const fallbackFaq = buildComparisonFaqItems(getPage("usdt-tether-vs-usde-ethena"))[1];
    expect(fallbackFaq.answer).toMatch(/^Safety is not decided by ticker alone\./);
  });
});
