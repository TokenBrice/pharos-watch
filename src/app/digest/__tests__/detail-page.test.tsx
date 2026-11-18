import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/breadcrumb-json-ld", () => ({ BreadcrumbJsonLd: () => null }));
vi.mock("@/components/digest/digest-snapshot", () => ({ DigestSnapshot: () => null }));
const colophonProps = vi.hoisted(() => [] as Array<{
  methodologyVersion?: string;
  citation?: { title: string; canonicalUrl: string; accessedDate?: string };
}>);
vi.mock("@/components/digest/editorial-colophon", () => ({
  EditorialColophon: (props: { methodologyVersion?: string; citation?: { title: string; canonicalUrl: string; accessedDate?: string } }) => {
    colophonProps.push(props);
    return null;
  },
}));
vi.mock("@/components/preferred-source-prompt", () => ({ PreferredSourcePrompt: () => null }));
vi.mock("@/components/digest/editorial-masthead", () => ({
  EditorialMasthead: ({ editor }: { editor?: string }) => <p>{editor}</p>,
}));
vi.mock("@/lib/digest", () => ({
  EDITORIAL_BODY_STYLE: {},
  formatDigestDateLabel: (date: string) => date,
  parseDigestParagraph: (paragraph: string) => ({ headerText: null, bodyText: paragraph }),
  splitDigestParagraphs: (extended: string) => [extended],
}));
vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));
vi.mock("@/lib/digest-registry", async (importOriginal) => {
  const registry = await importOriginal<typeof import("@/lib/digest-registry")>();
  const entry = (date: string, generatedAt: number, digestType: "daily" | "weekly", title = `Edition ${date}`) => ({
    date,
    title,
    text: "Summary",
    extended: "Extended",
    generatedAt,
    digestType,
    editionNumber: 1,
  });
  const entries = [
    {
      ...entry("2026-10-17", 1_792_224_322, "daily", "With model metadata"),
      llm: { servedModel: "claude-sonnet-5" },
    },
    entry("2026-10-12-weekly", 1_791_798_000, "weekly"),
    entry("2026-10-12", 1_791_792_376, "daily"),
    entry("2026-10-05-weekly", 1_791_187_800, "weekly"),
    entry("2026-10-05", 1_791_187_537, "daily"),
    entry("2026-02-25", 1_772_021_621, "daily", "Legacy edition"),
  ];
  return {
    ...registry,
    DIGEST_ENTRIES: entries,
    INDEXABLE_DIGEST_ENTRIES: entries.filter((row) => row.digestType === "weekly"),
    DIGEST_BY_DATE: {
      get(date: string) {
        return entries.find((row) => row.date === date) ?? registry.DIGEST_BY_DATE.get(date);
      },
    },
  };
});

import DigestDetailPage, { generateMetadata } from "../[date]/page";

async function renderDigest(date: string): Promise<string> {
  const page = await DigestDetailPage({ params: Promise.resolve({ date }) });
  return renderToStaticMarkup(page);
}

describe("digest detail model credit", () => {
  it("renders the persisted served model label", async () => {
    const html = await renderDigest("2026-10-17");

    expect(html).toContain("Claude Sonnet 5");
  });

  it("renders the not-recorded fallback for legacy editions", async () => {
    const html = await renderDigest("2026-02-25");

    expect(html).toContain("Model not recorded");
  });
});

describe("digest detail navigation", () => {
  it("links weekly recaps to the neighbouring weeklies instead of the adjacent daily editions", async () => {
    const newestWeekly = await renderDigest("2026-10-12-weekly");
    expect(newestWeekly).toContain('href="/digest/2026-10-05-weekly/"');
    expect(newestWeekly).not.toContain('href="/digest/2026-10-12/"');

    const oldestWeekly = await renderDigest("2026-10-05-weekly");
    expect(oldestWeekly).toContain('href="/digest/2026-10-12-weekly/"');
    expect(oldestWeekly).not.toContain('href="/digest/2026-02-25/"');
  });
});

describe("digest detail methodology version", () => {
  it("labels each archived edition with the methodology in force at publication", async () => {
    colophonProps.length = 0;

    await renderDigest("2026-10-17");
    await renderDigest("2026-02-25");

    expect(colophonProps.map((props) => props.methodologyVersion)).toEqual(["v10.21", "v1.0"]);
  });
});

describe("digest detail citation", () => {
  it("never reports the edition slug as an access date", async () => {
    colophonProps.length = 0;

    await renderDigest("2026-02-25");

    expect(colophonProps[0]?.citation).toEqual({
      title: "Legacy edition (2026-02-25)",
      canonicalUrl: "https://pharos.watch/digest/2026-02-25/",
    });
  });
});

it("shares the March 1 correction while keeping the original digest in the article", async () => {
  const date = "2026-03-01";
  const metadata = await generateMetadata({ params: Promise.resolve({ date }) });
  const html = await renderDigest(date);

  expect(metadata.description).toMatch(/Pharos retracted two KAU depeg claims and one KAG claim/);
  expect(metadata.openGraph?.description).toBe(metadata.description);
  expect(metadata.twitter?.description).toBe(metadata.description);
  expect(html).toContain(`"description":${JSON.stringify(metadata.description)}`);
  expect(html).toContain('"dateModified":"2026-11-18T00:00:00Z"');
  expect(html).toContain('aria-label="Editorial correction"');
  expect(html).toContain("KAU depegged twice in one day on $399.63M.");
});
