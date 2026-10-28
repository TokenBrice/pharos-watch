// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildComparisonAtAGlanceRows,
  COMPARISON_EVIDENCE_PILOT_SLUGS,
  getStaticComparisonPagesForCoin,
  STATIC_COMPARISON_PAGE_BY_SLUG,
} from "@/lib/compare-pages";
import ComparePairPage, { generateMetadata } from "./page";

const FIXED_NOW_SEC = Date.parse("2026-10-28T00:00:00Z") / 1_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_NOW_SEC * 1_000));
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderPair(slug: string) {
  const html = renderToStaticMarkup(await ComparePairPage({ params: Promise.resolve({ slug }) }));
  return new DOMParser().parseFromString(html, "text/html");
}

function getComparisonTable(document: Document): HTMLTableElement | null {
  const surface = document.querySelector('[data-testid="static-compare-at-a-glance-table"]');
  return surface?.querySelector("table") ?? null;
}

function readComparisonRows(document: Document) {
  const table = getComparisonTable(document);
  if (!table) throw new Error("missing comparison table");
  return [...table.querySelectorAll("tbody tr")].map((row) => {
    const [head, left, right] = row.children;
    return {
      label: head?.textContent ?? "",
      left: left?.textContent ?? "",
      right: right?.textContent ?? "",
    };
  });
}

function readComparisonItemList(document: Document) {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const parsed: unknown = JSON.parse(script.textContent ?? "null");
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    const itemList = nodes.find((node) => (node as { "@type"?: string } | null)?.["@type"] === "ItemList");
    if (itemList) return itemList as { numberOfItems: number; itemListElement: { item: { name: string; value: string } }[] };
  }
  return null;
}

describe("ComparePairPage", () => {
  it("links every other curated pair for each coin, excluding the current one", async () => {
    const slug = "usdt-tether-vs-usdc-circle";
    const document = await renderPair(slug);
    const section = document.getElementById("related-comparisons-title")?.closest("section");
    expect(section).not.toBeNull();

    const headings = [...section!.querySelectorAll("h3")].map((heading) => heading.textContent);
    expect(headings).toEqual(["More USDT comparisons", "More USDC comparisons"]);

    const hrefs = [...section!.querySelectorAll("a[href]")].map((link) => link.getAttribute("href") ?? "");
    expect(hrefs.some((href) => href.includes(slug))).toBe(false);
    for (const coinId of ["usdt-tether", "usdc-circle"]) {
      for (const page of getStaticComparisonPagesForCoin(coinId).filter((candidate) => candidate.slug !== slug)) {
        expect(hrefs.some((href) => href.includes(`/compare/${page.slug}`)), page.slug).toBe(true);
      }
    }
    // Anchor text is the pair's "{A} vs {B}" short title.
    expect(section!.textContent).toContain("USDT vs USDe");
  });

  it("names each coin and ticker in the profile action without splitting the single span", async () => {
    const document = await renderPair("usdt-tether-vs-usdc-circle");
    const profileLinks = [...document.querySelectorAll('a[href^="/stablecoin/"]')].filter((link) =>
      link.textContent?.startsWith("Open "));
    expect(profileLinks.map((link) => link.textContent)).toEqual([
      "Open Tether (USDT) profile →",
      "Open USD Coin (USDC) profile →",
    ]);
    expect(profileLinks.map((link) => link.getAttribute("href"))).toEqual([
      expect.stringMatching(/^\/stablecoin\/usdt-tether\/?$/),
      expect.stringMatching(/^\/stablecoin\/usdc-circle\/?$/),
    ]);
    const research = [...document.querySelectorAll('a[href^="/stablecoin/usdt-tether"]')]
      .filter((link) => link.textContent === "Tether (USDT) profile");
    expect(research).toHaveLength(1);
  });

  it.each([
    "jpyc-jpyc-vs-jpysc-sbi-startale",
    "usdy-ondo-finance-vs-usyc-hashnote",
    "eurc-circle-vs-eurcv-societe-generale-forge",
    "xaut-tether-vs-xaum-matrixdock",
    "usd1-world-liberty-financial-vs-usdt-tether",
    "brla-brla-digital-vs-brl1-brl1",
    "gho-aave-vs-sgho-aave",
    "usdf-falcon-vs-susdf-falcon",
    "apxusd-apyx-vs-apyusd-apyx",
  ])("registers the sibling-demand pair %s", async (slug) => {
    expect(STATIC_COMPARISON_PAGE_BY_SLUG.has(slug)).toBe(true);
    const document = await renderPair(slug);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    const page = STATIC_COMPARISON_PAGE_BY_SLUG.get(slug)!;
    const hasOtherPair = [page.left.id, page.right.id].some((coinId) =>
      getStaticComparisonPagesForCoin(coinId).some((candidate) => candidate.slug !== slug),
    );
    // The section only renders when either coin has another curated pair.
    expect(document.getElementById("related-comparisons-title") !== null).toBe(hasOtherPair);
  });
});

describe("ComparePairPage reviewed evidence rows", () => {
  it("renders every admitted row once and keeps source anchors inside the existing table", async () => {
    for (const slug of COMPARISON_EVIDENCE_PILOT_SLUGS) {
      const page = STATIC_COMPARISON_PAGE_BY_SLUG.get(slug)!;
      const rows = buildComparisonAtAGlanceRows(page, FIXED_NOW_SEC);
      const document = await renderPair(slug);
      const rendered = readComparisonRows(document);
      const table = getComparisonTable(document);
      expect(table, slug).not.toBeNull();
      expect(table!.querySelectorAll("caption")).toHaveLength(1);

      for (const row of rows) {
        expect(rendered.filter((candidate) => candidate.label === row.label), `${slug}:${row.label}`).toHaveLength(1);
      }
      const headers = [...table!.querySelectorAll("tbody th[scope='row']")].map((head) => head.textContent);
      expect(headers).toEqual(rows.map((row) => row.label));

      const hrefs = [...table!.querySelectorAll("a[href]")].map((anchor) => anchor.getAttribute("href"));
      for (const row of rows) {
        for (const source of [...(row.leftSources ?? []), ...(row.rightSources ?? [])]) {
          expect(hrefs, `${slug}:${source.href}`).toContain(source.href);
        }
      }
    }
  });

  it("names each source anchor with its symbol, row and source label", async () => {
    const slug = "usdc-circle-vs-usdg-paxos";
    const page = STATIC_COMPARISON_PAGE_BY_SLUG.get(slug)!;
    const rows = buildComparisonAtAGlanceRows(page, FIXED_NOW_SEC);
    const period = rows.find((row) => row.label === "Latest reviewed report period")!;
    const document = await renderPair(slug);
    const table = getComparisonTable(document)!;
    const anchors = [...table.querySelectorAll("a[aria-label]")];
    for (const [side, coin] of [["leftSources", page.left], ["rightSources", page.right]] as const) {
      const source = period[side]![0];
      const anchor = anchors.find(
        (candidate) => candidate.getAttribute("aria-label") === `${coin.symbol} Latest reviewed report period: ${source.label}`,
      );
      expect(anchor, source.label).toBeDefined();
      expect(anchor!.getAttribute("title")).toBe(source.label);
      expect(anchor!.textContent).toBe("[1]");
      expect(anchor!.getAttribute("href")).toBe(source.href);
    }
  });

  it("renders missing cells explicitly and hides wholly empty rows", async () => {
    const document = await renderPair("usde-ethena-vs-usds-sky");
    const rows = readComparisonRows(document);
    const period = rows.find((row) => row.label === "Latest reviewed report period");
    expect(period?.left).toContain("2026-09-27");
    expect(period?.right).toContain("Not recorded");
    expect(rows.some((row) => row.label === "Assurance scope" && row.left.includes("Method not established"))).toBe(true);
    expect(rows.some((row) => row.label === "Redemption minimum")).toBe(false);

    const usdcUsdg = readComparisonRows(await renderPair("usdc-circle-vs-usdg-paxos"));
    expect(usdcUsdg.some((row) => row.label === "Redemption minimum")).toBe(false);

    const usdtUsdc = readComparisonRows(await renderPair("usdt-tether-vs-usdc-circle"));
    const minimum = usdtUsdc.find((row) => row.label === "Redemption minimum");
    expect(minimum?.left).toContain("$100,000");
    expect(minimum?.right).toContain("Not recorded");
    expect(usdtUsdc.find((row) => row.label === "Redemption fee basis")?.left).toContain(
      "minimum fee of $1,000",
    );
  });

  it("keeps the untreated route's layout and adds no evidence rows", async () => {
    const document = await renderPair("usdt-tether-vs-dai-makerdao");
    const rows = readComparisonRows(document);
    expect(rows.map((row) => row.label)).not.toContain("Latest reviewed report period");
    expect(rows.map((row) => row.label)).not.toContain("Assurance scope");
    expect(rows.map((row) => row.label)).not.toContain("Direct redemption eligibility");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(getComparisonTable(document)).not.toBeNull();
  });

  it("replaces the blanket attestation strings with resolved engagement labels", async () => {
    const document = await renderPair("usdt-tether-vs-usdc-circle");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Independent Attestation");
    expect(text).not.toContain("BDO Italia reserve attestations");
    expect(text).toContain("Examination");
  });

  it("keeps one H1 and a self canonical on all pilot and untreated routes", async () => {
    for (const slug of [...COMPARISON_EVIDENCE_PILOT_SLUGS, "usdt-tether-vs-dai-makerdao"]) {
      const document = await renderPair(slug);
      expect(document.querySelectorAll("h1"), slug).toHaveLength(1);
      const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
      expect(metadata.alternates?.canonical, slug).toBe(`/compare/${slug}/`);
    }
  });

  it("keeps JSON-LD ItemList values equal to the visible row text without anchors", async () => {
    for (const slug of COMPARISON_EVIDENCE_PILOT_SLUGS) {
      const page = STATIC_COMPARISON_PAGE_BY_SLUG.get(slug)!;
      const rows = buildComparisonAtAGlanceRows(page, FIXED_NOW_SEC);
      const document = await renderPair(slug);
      const itemList = readComparisonItemList(document);
      expect(itemList, slug).not.toBeNull();
      expect(itemList!.numberOfItems).toBe(rows.length);
      expect(itemList!.itemListElement.map((element) => element.item.name)).toEqual(rows.map((row) => row.label));
      expect(itemList!.itemListElement.map((element) => element.item.value)).toEqual(
        rows.map((row) => `${page.left.symbol}: ${row.left}; ${page.right.symbol}: ${row.right}`),
      );
      expect(JSON.stringify(itemList)).not.toContain("[object Object]");
      expect(JSON.stringify(itemList)).not.toContain("<a ");
    }
  });

  it("replaces the old table source note with the evidence-scoped note", async () => {
    const document = await renderPair("usdt-tether-vs-usdc-circle");
    const sectionText = getComparisonTable(document)?.closest("section")?.textContent ?? "";
    expect(sectionText).toContain(
      "Report periods and redemption review dates refer to the linked evidence. Fees describe issuer or protocol charges; bank, network and delivery costs may apply.",
    );
    expect(sectionText).not.toContain("Source: checked-in StablecoinMeta profile fields");
  });
});
