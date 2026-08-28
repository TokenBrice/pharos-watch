import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BLOG_POSTS } from "@/data/blog";
import { CASE_STUDY_LIST } from "@/lib/case-studies";
import { DIGEST_ENTRIES } from "@/lib/digest-registry";
import { getMechanismExplainerPath } from "@shared/lib/classification";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";

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
import MechanismPage, * as mechanismRoute from "@/app/learn/mechanisms/[archetype]/page";

describe("static content route adapters", () => {
  it("emits the exact registered static-param sets", () => {
    expect(blogRoute.generateStaticParams()).toEqual(BLOG_POSTS.map(({ slug }) => ({ slug })));
    expect(docsRoute.generateStaticParams()).toEqual(PUBLIC_DOCS.map(({ slug }) => ({ slug })));
    expect(digestRoute.generateStaticParams()).toEqual(DIGEST_ENTRIES.map(({ date }) => ({ date })));
    expect(caseStudyRoute.generateStaticParams()).toEqual(CASE_STUDY_LIST.map(({ slug }) => ({ slug })));
    expect(mechanismRoute.generateStaticParams()).toEqual(
      MECHANISM_ARCHETYPE_VALUES.map((archetype) => ({ archetype })),
    );
  });

  it("projects each registry key into its canonical metadata", async () => {
    const blog = BLOG_POSTS[0]!;
    const doc = PUBLIC_DOCS[0]!;
    const digest = DIGEST_ENTRIES[0]!;
    const study = CASE_STUDY_LIST[0]!;
    const archetype = MECHANISM_ARCHETYPE_VALUES[0]!;

    expect((await blogRoute.generateMetadata({ params: Promise.resolve({ slug: blog.slug }) })).alternates?.canonical)
      .toBe(`/blog/${blog.slug}/`);
    expect((await docsRoute.generateMetadata({ params: Promise.resolve({ slug: doc.slug }) })).alternates?.canonical)
      .toBe(`/docs/${doc.slug}/`);
    expect((await digestRoute.generateMetadata({ params: Promise.resolve({ date: digest.date }) })).alternates?.canonical)
      .toBe(`/digest/${digest.date}/`);
    expect((await caseStudyRoute.generateMetadata({ params: Promise.resolve({ slug: study.slug }) })).alternates?.canonical)
      .toBe(`/learn/case-studies/${study.slug}/`);
    expect((await mechanismRoute.generateMetadata({ params: Promise.resolve({ archetype }) })).alternates?.canonical)
      .toBe(getMechanismExplainerPath(archetype));
  });

  it("returns route-specific missing metadata and rejects missing pages", async () => {
    const missing = "not-a-real-entry";
    expect(await blogRoute.generateMetadata({ params: Promise.resolve({ slug: missing }) })).toEqual({
      title: "Post Not Found",
    });
    expect(await digestRoute.generateMetadata({ params: Promise.resolve({ date: missing }) })).toEqual({
      title: "Digest Not Found",
      robots: { index: false },
    });
    expect(await caseStudyRoute.generateMetadata({ params: Promise.resolve({ slug: missing }) })).toEqual({
      title: "Not Found",
      robots: { index: false, follow: false },
    });

    await expect(BlogPage({ params: Promise.resolve({ slug: missing }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(DocPage({ params: Promise.resolve({ slug: missing }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(DigestPage({ params: Promise.resolve({ date: missing }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(CaseStudyPage({ params: Promise.resolve({ slug: missing }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(MechanismPage({ params: Promise.resolve({ archetype: missing }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("keeps Learn breadcrumbs and article JSON-LD inside each route renderer", async () => {
    const study = CASE_STUDY_LIST[0]!;
    const archetype = MECHANISM_ARCHETYPE_VALUES[0]!;
    const caseHtml = renderToStaticMarkup(await CaseStudyPage({ params: Promise.resolve({ slug: study.slug }) }));
    const mechanismHtml = renderToStaticMarkup(await MechanismPage({ params: Promise.resolve({ archetype }) }));

    expect(caseHtml).toContain('"name":"Case Studies"');
    expect(caseHtml).toContain('type="application/ld+json"');
    expect(mechanismHtml).toContain('"name":"Mechanisms"');
    expect(mechanismHtml).toContain('type="application/ld+json"');
  });
});
