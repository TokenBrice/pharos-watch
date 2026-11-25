// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import { CASE_STUDY_LIST, CASE_STUDY_OUTCOME_COUNTS } from "@/lib/case-studies";
import { MECHANISM_ARCHETYPE_LABELS } from "@shared/lib/classification";
import type { CaseStudy } from "@shared/types/editorial-content";
import { CaseStudyBody } from "../case-study-body";
import { CaseStudyArticleMeta } from "../case-study-meta";
import { CaseStudyShare } from "../case-study-share";
import { CaseStudyArticleJsonLd } from "../case-study-json-ld";
import { CaseStudyTimeline } from "../case-study-timeline";
import { CaseStudyList, type CaseStudyListItem } from "../case-study-list";
import CaseStudiesHub, { metadata as hubMetadata } from "../page";
import CaseStudyPage, { generateMetadata } from "../[slug]/page";

const MOCKED_SVB_MODIFIED = "2026-09-30T12:00:00+00:00";

vi.mock("@/generated/sitemap-dates.json", () => ({
  default: { "/learn/case-studies/usdc-svb-2023/": "2026-09-30T12:00:00+00:00" },
}));

vi.mock("../case-study-chart", () => ({
  CaseStudyChart: () => <div data-testid="case-study-chart" />,
}));

describe("case-study publication metadata", () => {
  it("uses the search-phrased metaTitle when present and the editorial title otherwise", async () => {
    const titleFor = async (slug: string) => (await generateMetadata({ params: Promise.resolve({ slug }) })).title;
    expect(await titleFor("usdc-svb-2023")).toBe("USDC Depeg, March 2023: The SVB Case Study");
    const usde = await titleFor("usde-oracle-2025");
    expect(usde).toBe("USDe's $0.65 Binance Print (Oct 2025), Explained");
    expect(String(usde)).not.toMatch(/depeg/i);
    const untitled = CASE_STUDY_LIST.find((study) => !study.metaTitle)!;
    expect(await titleFor(untitled.slug)).toBe(untitled.title);
  });

  it("counts the archive and its outcomes in the hub title and description", () => {
    expect(hubMetadata.title).toBe(`Stablecoin Depeg History: ${CASE_STUDY_LIST.length} Case Studies`);
    const description = String(hubMetadata.description);
    expect(description).toContain(
      `(${CASE_STUDY_OUTCOME_COUNTS.died} died, ${CASE_STUDY_OUTCOME_COUNTS.wounded} wounded, ${CASE_STUDY_OUTCOME_COUNTS.survived} survived)`,
    );
    expect(description).toContain("depeg and failure case studies");
    expect(description).not.toMatch(/reconstructed stablecoin depegs|how each ended/i);
    expect(CASE_STUDY_OUTCOME_COUNTS.died + CASE_STUDY_OUTCOME_COUNTS.wounded + CASE_STUDY_OUTCOME_COUNTS.survived).toBe(CASE_STUDY_LIST.length);
  });

  it("labels venue-scoped deviation metrics at the point of display", () => {
    const study = CASE_STUDY_LIST.find((entry) => entry.slug === "usde-oracle-2025")!;
    const html = renderToStaticMarkup(<CaseStudyBody study={study} />);
    expect(html).toContain("Scope: Binance order-book print");
  });

  it("drops NAV-priced widgets so the archival snapshot renders instead of a $1 tape", () => {
    for (const slug of ["usyc-nav-pricing-2025", "usd0pp-usual-2025"]) {
      const study = CASE_STUDY_LIST.find((entry) => entry.slug === slug)!;
      const html = renderToStaticMarkup(<CaseStudyBody study={study} />);
      expect(html, slug).not.toContain('data-testid="case-study-chart"');
      expect(html, slug).toContain("Archival record");
      expect(html, slug).toContain("Event window");
      expect(html, slug).not.toContain("Par to low:");
    }
  });

  it("drops a non-USD widget that would be drawn on a $1 tape", () => {
    const base = CASE_STUDY_LIST.find((entry) => entry.slug === "usdc-svb-2023")!;
    const study: CaseStudy = {
      ...base,
      dataWidgets: [
        { kind: "peg-deviation", coinId: "eurot-token-teknoloji", caption: "EUR test" },
      ],
    };
    const html = renderToStaticMarkup(<CaseStudyBody study={study} />);
    expect(html).not.toContain('data-testid="case-study-chart"');
    expect(html).toContain("Event window");
  });

  it("keeps a USD peg tape for a non-NAV widget and shows par-to-low track on USD archival studies", () => {
    const usdc = CASE_STUDY_LIST.find((entry) => entry.slug === "usdc-svb-2023")!;
    const usdcHtml = renderToStaticMarkup(<CaseStudyBody study={usdc} />);
    expect(usdcHtml).toContain('data-testid="case-study-chart"');
    expect(usdcHtml).toContain("-1,300 bps");

    const terra = CASE_STUDY_LIST.find((entry) => entry.slug === "terra-ust-2022")!;
    const terraHtml = renderToStaticMarkup(<CaseStudyBody study={terra} />);
    expect(terraHtml).toContain("Archival record");
    expect(terraHtml).toContain("-9,900 bps");
    expect(terraHtml).toContain("Par to low:");
    expect(terraHtml).toContain("$0.010");
  });

  it("shows an unavailable archival metric as an em dash", () => {
    const study = CASE_STUDY_LIST.find((entry) => entry.slug === "usyc-nav-pricing-2025")!;
    const html = renderToStaticMarkup(<CaseStudyBody study={study} />);
    expect(html).not.toContain("n/a");
    expect(html.match(/—/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the authored Published byline, article fold order, and per-study sitemap dateModified", async () => {
    const study = CASE_STUDY_LIST.find((entry) => entry.slug === "usdc-svb-2023")!;
    const metaHtml = renderToStaticMarkup(<CaseStudyArticleMeta study={study} />);
    expect(metaHtml).toContain(`Published <time dateTime="${study.datePublished}">`);
    expect(metaHtml).toMatch(/href="\/about\/?#editorial-ai-policy"/);
    expect(metaHtml).not.toMatch(/Updated/);

    const pageEl = await CaseStudyPage({ params: Promise.resolve({ slug: study.slug }) });
    const pageHtml = renderToStaticMarkup(pageEl);
    expect(pageHtml).toContain("All case studies");
    expect(pageHtml).toContain(`Published <time dateTime="${study.datePublished}">`);
    expect(pageHtml).toContain('aria-label="Case study table of contents"');
    const leadSnippet = study.lead[0]!.slice(0, 32);
    const factStripIdx = pageHtml.indexOf("Peak deviation");
    const tocIdx = pageHtml.indexOf('aria-label="Case study table of contents"');
    const leadIdx = pageHtml.indexOf(leadSnippet);
    expect(factStripIdx).toBeGreaterThan(-1);
    expect(tocIdx).toBeGreaterThan(factStripIdx);
    expect(leadIdx).toBeGreaterThan(tocIdx);
    expect(pageHtml).not.toMatch(/Updated/);

    const article = JSON.parse(
      renderToStaticMarkup(<CaseStudyArticleJsonLd study={study} />).replace(/^<script[^>]*>|<\/script>$/g, ""),
    ) as { dateModified: string; datePublished: string };
    expect(article.dateModified).toBe(MOCKED_SVB_MODIFIED);
    expect(article.datePublished.startsWith(study.datePublished.slice(0, 10))).toBe(true);
  });

  it("deduplicates RelatedStudies against crossLinks", () => {
    const study = CASE_STUDY_LIST.find((entry) => entry.slug === "usdc-svb-2023")!;
    const html = renderToStaticMarkup(<CaseStudyBody study={study} />);
    const relatedSectionStart = html.indexOf("Related case studies");
    const pagerStart = html.indexOf('aria-label="Case study pager"');
    const relatedSlice = html.slice(relatedSectionStart, pagerStart);
    expect(relatedSlice).not.toContain("/learn/case-studies/dai-black-thursday/");
  });

  it("falls back to the publication date when a study has no sitemap date", () => {
    const study = CASE_STUDY_LIST.find((entry) => entry.slug !== "usdc-svb-2023")!;
    const article = JSON.parse(
      renderToStaticMarkup(<CaseStudyArticleJsonLd study={study} />).replace(/^<script[^>]*>|<\/script>$/g, ""),
    ) as { dateModified: string };
    expect(article.dateModified).toBe(study.datePublished);
  });
});

describe("case-study sharing and interactive surfaces", () => {
  afterEach(() => {
    cleanupFrontendTest();
    window.history.replaceState(null, "", "/");
  });

  it("keeps confirmation until two seconds after the latest successful copy", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CaseStudyShare />);
    const button = screen.getByRole("button", { name: "Copy link" });
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    await act(async () => { fireEvent.click(button); });
    expect(status.textContent).toBe("Link copied");
    expect(button.textContent).toContain("Copied");
    act(() => { vi.advanceTimersByTime(1900); });
    await act(async () => { fireEvent.click(button); });
    expect(writeText.mock.calls).toEqual([[window.location.href], [window.location.href]]);
    act(() => { vi.advanceTimersByTime(1999); });
    expect(status.textContent).toBe("Link copied");
    act(() => { vi.advanceTimersByTime(1); });
    expect(status.textContent).toBe("");
  });

  it("renders hub outcome ledger, sentence-case Start here, count parity, sort, and empty-state reset", () => {
    const hubHtml = renderToStaticMarkup(<CaseStudiesHub />);
    expect(hubHtml).toContain("Outcome ledger");
    expect(hubHtml).toContain("Start here");
    expect(hubHtml).not.toContain(">Start Here<");
    expect(hubHtml).toContain('id="start-here"');

    const sampleItems: CaseStudyListItem[] = [
      {
        slug: "alpha-2023",
        title: "Alpha",
        subtitle: "Alpha sub",
        eyebrow: "Bank shock",
        archetype: "fiat-cash",
        outcome: "survived",
        eventDateLabel: "March 2023",
        eventStartISO: "2023-03-10",
        peakDeviationBps: -1300,
        lowPrice: 0.87,
        metricScope: null,
        readingMinutes: 5,
        primaryCoinLogoSrc: null,
        primaryCoinSymbol: "ALP",
      },
      {
        slug: "beta-2025",
        title: "Beta",
        subtitle: "Beta sub",
        eyebrow: "Collapse",
        archetype: "cdp",
        outcome: "died",
        eventDateLabel: "May 2025",
        eventStartISO: "2025-05-01",
        peakDeviationBps: -7900,
        lowPrice: 0.21,
        metricScope: null,
        readingMinutes: 6,
        primaryCoinLogoSrc: null,
        primaryCoinSymbol: "BET",
      },
    ];

    render(
      <CaseStudyList
        studies={sampleItems}
        archetypeLabels={MECHANISM_ARCHETYPE_LABELS}
        priorityStudies={[
          { outcome: "died", archetype: "algorithmic" },
          { outcome: "died", archetype: "algorithmic" },
          { outcome: "died", archetype: "algorithmic" },
        ]}
      />,
    );

    expect(screen.getByText(/reflexive-collapse primers above/i)).toBeTruthy();

    const sortGroup = screen.getByRole("group", { name: "Sort case studies" });
    fireEvent.click(within(sortGroup).getByRole("button", { name: "Deepest depeg" }));
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Beta", "Alpha"]);

    const outcomeGroup = screen.getByRole("group", { name: "Filter by outcome" });
    fireEvent.click(within(outcomeGroup).getByRole("button", { name: "Died" }));
    expect(screen.getByRole("link", { name: /\(\+3 in Start here\)/i }).getAttribute("href")).toBe("#start-here");

    const mechGroup = screen.getByRole("group", { name: "Filter by mechanism" });
    fireEvent.click(
      within(mechGroup).getByRole("button", {
        name: (accessibleName) => accessibleName.includes(MECHANISM_ARCHETYPE_LABELS["fiat-cash"]),
      }),
    );
    expect(screen.getByText(/No archive case studies match these filters/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("renders visible timeline severity labels and switches Track/Linear without details chrome", () => {
    const study = CASE_STUDY_LIST.find((entry) => entry.slug === "usdc-svb-2023")!;
    const { container } = render(<CaseStudyTimeline entries={study.timeline} />);
    expect(container.querySelector("details")).toBeNull();
    expect(screen.getAllByText(/^High$/).length).toBeGreaterThan(1);

    const viewGroup = screen.getByRole("group", { name: "Timeline layout" });
    const linearBtn = within(viewGroup).getByRole("button", { name: "Linear" });
    fireEvent.click(linearBtn);
    expect(linearBtn.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll("ol")).toHaveLength(1);
  });
});
