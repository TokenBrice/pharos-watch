import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BLOG_POSTS } from "@/data/blog";
import { CASE_STUDY_LIST } from "@/lib/case-studies";
import { DIGEST_BY_DATE, DIGEST_ENTRIES } from "@/lib/digest-registry";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { getMechanismExplainerPath } from "@shared/lib/classification";
import { computeFailureScenarioContentHash } from "@shared/lib/failure-scenarios";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { FailureScenario } from "@shared/types/failure-scenarios";
import { PUBLISHED_FAILURE_SCENARIOS, selectPublishedFailureScenarios } from "@/lib/failure-scenario-index";
import { CaseStudyArticleJsonLd, CaseStudyListJsonLd } from "@/app/learn/case-studies/case-study-json-ld";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("next/font/local", () => ({
  default: () => ({ className: "font-test", variable: "--font-test" }),
}));

vi.mock("@/app/learn/case-studies/case-study-body", () => ({
  CaseStudyBody: () => <div>Case study body</div>,
}));

import BlogPage, * as blogRoute from "@/app/blog/[slug]/page";
import DigestPage, * as digestRoute from "@/app/digest/[date]/page";
import DocPage, * as docsRoute from "@/app/docs/[slug]/page";
import CaseStudyPage, * as caseStudyRoute from "@/app/learn/case-studies/[slug]/page";
import FailureScenariosHub from "@/app/learn/scenarios/page";
import MechanismPage, * as mechanismRoute from "@/app/learn/mechanisms/[archetype]/page";
import { MechanismComparisonMatrix } from "@/app/learn/mechanisms/comparison-matrix";

const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

describe("static content route adapters", () => {
  it.each([
    ["USDS Yield Repeats As Blacklists Multiply", "USDS Yield Repeats As Blacklists…"],
    ["A Quiet Week", "A Quiet Week"],
  ])("bounds digest metadata while preserving its date: %s", async (headline, expectedTitle) => {
    const date = "2026-09-14-weekly";
    const lookup = vi.spyOn(DIGEST_BY_DATE, "get").mockReturnValueOnce({
      ...DIGEST_ENTRIES[0]!, date, title: headline, digestType: "weekly",
    });
    try {
      const metadata = await digestRoute.generateMetadata(p({ date }));
      expect(metadata.title).toBe(`${expectedTitle} (September 14, 2026)`);
      expect(`${metadata.title} | Pharos`.length).toBeLessThanOrEqual(70);
    } finally {
      lookup.mockRestore();
    }
  });

  it("emits the exact registered static-param sets", () => {
    expect(blogRoute.generateStaticParams()).toEqual(BLOG_POSTS.map(({ slug }) => ({ slug })));
    expect(docsRoute.generateStaticParams()).toEqual(PUBLIC_DOCS.map(({ slug }) => ({ slug })));
    expect(digestRoute.generateStaticParams()).toEqual(DIGEST_ENTRIES.map(({ date }) => ({ date })));
    expect(caseStudyRoute.generateStaticParams()).toEqual(CASE_STUDY_LIST.map(({ slug }) => ({ slug })));
    expect(mechanismRoute.generateStaticParams()).toEqual(
      MECHANISM_ARCHETYPE_VALUES.map((archetype) => ({ archetype })),
    );
  });

  it("keeps article previews destination-specific without changing canonical identities", async () => {
    const routes = [
      ...CASE_STUDY_LIST.map(({ slug }) => ({
        canonical: `/learn/case-studies/${slug}/`,
        metadata: caseStudyRoute.generateMetadata(p({ slug })),
      })),
      ...MECHANISM_ARCHETYPE_VALUES.map((archetype) => ({
        canonical: getMechanismExplainerPath(archetype),
        metadata: mechanismRoute.generateMetadata(p({ archetype })),
      })),
    ];
    for (const route of routes) {
      const metadata = await route.metadata;
      expect(metadata.alternates?.canonical).toBe(route.canonical);
      expect(metadata.openGraph).toMatchObject({
        images: [expect.objectContaining({ url: expect.stringMatching(/^\/og\/v2\//) })],
      });
      expect(metadata.twitter?.images).toEqual(metadata.openGraph?.images);
    }
    const first = await routes[0].metadata;
    const second = await routes[1].metadata;
    expect(first.openGraph?.images).not.toEqual(second.openGraph?.images);
  });

  it("shares blog posts as articles with their publication time", async () => {
    const [post] = BLOG_POSTS;
    expect((await blogRoute.generateMetadata(p({ slug: post.slug }))).openGraph)
      .toMatchObject({ type: "article", publishedTime: `${post.datePublished}T00:00:00Z` });
  });

  it("heads the mechanism matrix for its query while keeping its rows and caption registry-owned", () => {
    const html = renderToStaticMarkup(<MechanismComparisonMatrix />);

    expect(html).toContain('id="mechanism-matrix-heading"');
    expect(html).toContain("Types of stablecoins");
    expect(html).not.toContain("At a glance");
    expect(html.replace(/<[^>]+>/g, "")).toContain(`${MECHANISM_ARCHETYPE_VALUES.length} mechanisms`);
    expect(html).toContain("Stablecoin mechanism comparison matrix");
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      expect(html).toContain(`href="${getMechanismExplainerPath(archetype)}`);
    }
  });

  it("describes multi-model archetypes without collapsing them to one collateral or redemption model", () => {
    const html = renderToStaticMarkup(<MechanismComparisonMatrix />);

    expect(html).toContain("none to protocol collateral");
    expect(html).toContain("NAV or par");
  });

  it("keeps article and hub structured images specific to their case study", () => {
    const articleImages = new Map<string, string>();
    for (const study of CASE_STUDY_LIST) {
      const html = renderToStaticMarkup(<CaseStudyArticleJsonLd study={study} />);
      const article = JSON.parse(html.match(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/s)![1]);
      expect(article).toMatchObject({
        "@type": "Article",
        url: `${SITE_ORIGIN}/learn/case-studies/${study.slug}/`,
        headline: study.title,
      });
      expect(article.image.startsWith(`${SITE_ORIGIN}/og/v2/`)).toBe(true);
      articleImages.set(study.slug, article.image);
    }
    const html = renderToStaticMarkup(<CaseStudyListJsonLd studies={CASE_STUDY_LIST} />);
    const hub = JSON.parse(html.match(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/s)![1]);
    expect(hub.itemListElement).toEqual(CASE_STUDY_LIST.map((study, index) => expect.objectContaining({
      position: index + 1,
      url: `${SITE_ORIGIN}/learn/case-studies/${study.slug}/`,
      item: expect.objectContaining({ "@type": "Article", name: study.title, image: articleImages.get(study.slug) }),
    })));
    expect(articleImages.get(CASE_STUDY_LIST[0].slug)).not.toBe(articleImages.get(CASE_STUDY_LIST[1].slug));
  });

  it("lists exactly the published failure scenarios on /learn/scenarios/ and filters ineligible records", () => {
    const html = renderToStaticMarkup(<FailureScenariosHub />);
    const hrefs = [...html.matchAll(/href="([^"]+#how-it-breaks)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual(PUBLISHED_FAILURE_SCENARIOS.map(({ id }) => `${buildStablecoinUrl(id)}#how-it-breaks`));
    expect(html).toContain("not Safety Score inputs");
    const withWindow = PUBLISHED_FAILURE_SCENARIOS.find((e) => e.scenario.window);
    if (withWindow) expect(html).toContain(`${withWindow.scenario.window!.label}:`);
    else if (PUBLISHED_FAILURE_SCENARIOS.length === 0) expect(html).toContain("None published.");

    const [activeId, draftId, metId] = TRACKED_STABLECOINS
      .filter((c) => c.status == null || c.status === "active")
      .map((c) => c.id);
    const st = { id: "a", kind: "authority-capture" as const, title: "t", actor: "a", action: "a()", actionIsCode: true, elapsed: "0", cost: "0", explanation: "e", evidence: "inferred" as const, sourceIds: ["s"] };
    const base: FailureScenario = {
      coinId: activeId, title: "t", thesis: "t", premise: "p",
      stages: [st, { ...st, id: "b", kind: "holder-outcome", sourceIds: [] }],
      keyFigures: [], defenders: [], exposure: [],
      falsifiers: [{ id: "f", condition: "c", status: "not-met", checkedAtBlock: 1 }],
      sources: [{ id: "s", label: "s", url: "https://example.com", observedAt: "2026-10-07", block: 1 }],
      evidencePin: { chainId: 1, block: 1, observedAt: "2026-10-07" },
      review: { status: "draft" },
    };
    const approve = (coinId: string, patch: Partial<FailureScenario> = {}): FailureScenario => {
      const rec: FailureScenario = { ...base, ...patch, coinId };
      return { ...rec, review: { status: "approved", reviewedBy: "t", reviewedAt: "2026-10-08T00:00:00Z", contentSha256: computeFailureScenarioContentHash(rec) } };
    };
    const [pre, delisted, quar] = (["pre-launch", "delisted", "quarantined"] as const).map(
      (s) => TRACKED_STABLECOINS.find((c) => c.status === s)!.id,
    );
    const clock = new Date("2026-11-01T00:00:00Z");
    expect(selectPublishedFailureScenarios({}, clock)).toEqual([]);
    const out = selectPublishedFailureScenarios({
      [activeId]: approve(activeId),
      [draftId]: { ...base, coinId: draftId },
      [metId]: approve(metId, { falsifiers: [{ ...base.falsifiers[0]!, status: "met" }] }),
      [pre]: approve(pre),
      [delisted]: approve(delisted),
      [quar]: approve(quar),
    }, clock);
    expect(out.map((e) => e.id)).toEqual([activeId]);
  });

  it("returns route-specific missing metadata and rejects missing pages", async () => {
    const missing = "not-a-real-entry";
    expect(await blogRoute.generateMetadata(p({ slug: missing }))).toEqual({ title: "Post Not Found" });
    expect(await digestRoute.generateMetadata(p({ date: missing }))).toEqual({
      title: "Digest Not Found",
      robots: { index: false },
    });
    expect(await caseStudyRoute.generateMetadata(p({ slug: missing }))).toEqual({
      title: "Not Found",
      robots: { index: false, follow: false },
    });

    for (const call of [
      BlogPage(p({ slug: missing })),
      DocPage(p({ slug: missing })),
      DigestPage(p({ date: missing })),
      CaseStudyPage(p({ slug: missing })),
      MechanismPage(p({ archetype: missing })),
    ]) {
      await expect(call).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

});
