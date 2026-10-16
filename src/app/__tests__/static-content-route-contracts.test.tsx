import { describe, expect, it, vi } from "vitest";
import { BLOG_POSTS } from "@/data/blog";
import { CASE_STUDY_LIST } from "@/lib/case-studies";
import { DIGEST_BY_DATE, DIGEST_ENTRIES } from "@/lib/digest-registry";
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
  it.each([
    ["USDS Yield Repeats As Blacklists Multiply", "USDS Yield Repeats As Blacklists…"],
    ["A Quiet Week", "A Quiet Week"],
  ])("bounds digest metadata while preserving its date: %s", async (headline, expectedTitle) => {
    const date = "2026-09-14-weekly";
    const lookup = vi.spyOn(DIGEST_BY_DATE, "get").mockReturnValueOnce({
      ...DIGEST_ENTRIES[0]!, date, title: headline, digestType: "weekly",
    });
    try {
      const metadata = await digestRoute.generateMetadata({ params: Promise.resolve({ date }) });
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

});
