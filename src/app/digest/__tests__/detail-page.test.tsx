import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/breadcrumb-json-ld", () => ({ BreadcrumbJsonLd: () => null }));
vi.mock("@/components/digest-snapshot", () => ({ DigestSnapshot: () => null }));
vi.mock("@/components/editorial-colophon", () => ({ EditorialColophon: () => null }));
vi.mock("@/components/preferred-source-prompt", () => ({ PreferredSourcePrompt: () => null }));
vi.mock("@/components/json-ld-script", () => ({ JsonLdScript: () => null }));
vi.mock("@/components/editorial-masthead", () => ({
  EditorialMasthead: ({ editor }: { editor?: string }) => <p>{editor}</p>,
}));
vi.mock("@/lib/digest", () => ({
  EDITORIAL_BODY_STYLE: {},
  formatDigestDateLabel: (date: string) => date,
  parseDigestParagraph: (paragraph: string) => ({ headerText: null, bodyText: paragraph }),
  splitDigestParagraphs: (extended: string) => [extended],
}));
vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));
vi.mock("@/lib/json-ld", () => ({
  buildArticleJsonLd: () => ({}),
  safeJsonLd: (value: unknown) => value,
}));
vi.mock("@/lib/page-metadata", () => ({
  buildPageMetadata: () => ({}),
  summarizeText: (text: string) => text,
  trimTextAtWordBoundary: (text: string) => text,
}));
vi.mock("@/lib/digest-registry", () => {
  const entries = [
    {
      date: "2026-07-01",
      title: "With model metadata",
      text: "Summary",
      extended: "Extended",
      generatedAt: 1_000,
      digestType: "daily",
      editionNumber: 1,
      llm: { servedModel: "claude-sonnet-5" },
    },
    {
      date: "2026-06-30",
      title: "Legacy edition",
      text: "Summary",
      extended: "Extended",
      generatedAt: 999,
      digestType: "daily",
      editionNumber: 0,
    },
  ];
  return {
    DIGEST_ENTRIES: entries,
    DIGEST_BY_DATE: {
      get(date: string) {
        return entries.find((entry) => entry.date === date);
      },
    },
  };
});

import DigestDetailPage from "../[date]/page";

async function renderDigest(date: string): Promise<string> {
  const page = await DigestDetailPage({ params: Promise.resolve({ date }) });
  return renderToStaticMarkup(page);
}

describe("digest detail model credit", () => {
  it("renders the persisted served model label", async () => {
    const html = await renderDigest("2026-07-01");

    expect(html).toContain("Claude Sonnet 5");
  });

  it("renders the not-recorded fallback for legacy editions", async () => {
    const html = await renderDigest("2026-06-30");

    expect(html).toContain("Model not recorded");
  });
});
