import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CASE_STUDY_LIST, CASE_STUDY_OUTCOME_COUNTS } from "@/lib/case-studies";
import { CaseStudyBody } from "../case-study-body";
import { CaseStudyArticleJsonLd } from "../case-study-json-ld";
import { metadata as hubMetadata } from "../page";
import { generateMetadata } from "../[slug]/page";

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

  it("keeps the authored Published byline and takes Article dateModified from the per-study sitemap date", () => {
    const study = CASE_STUDY_LIST.find((entry) => entry.slug === "usdc-svb-2023")!;
    const body = renderToStaticMarkup(<CaseStudyBody study={study} />);
    expect(body).toContain(`Published <time dateTime="${study.datePublished}">`);
    expect(body).not.toMatch(/Updated/);

    const article = JSON.parse(
      renderToStaticMarkup(<CaseStudyArticleJsonLd study={study} />).replace(/^<script[^>]*>|<\/script>$/g, ""),
    ) as { dateModified: string; datePublished: string };
    expect(article.dateModified).toBe(MOCKED_SVB_MODIFIED);
    expect(article.datePublished.startsWith(study.datePublished.slice(0, 10))).toBe(true);
  });

  it("falls back to the publication date when a study has no sitemap date", () => {
    const study = CASE_STUDY_LIST.find((entry) => entry.slug !== "usdc-svb-2023")!;
    const article = JSON.parse(
      renderToStaticMarkup(<CaseStudyArticleJsonLd study={study} />).replace(/^<script[^>]*>|<\/script>$/g, ""),
    ) as { dateModified: string };
    expect(article.dateModified).toBe(study.datePublished);
  });
});
