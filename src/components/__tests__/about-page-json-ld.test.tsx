import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AboutPageContent } from "@/components/about/about-page-content";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isLaunchedAwaitingData } from "@/lib/pre-launch";

vi.mock("next/link", async () => {
  // Vitest hoists mock factories; import the shared mock inside its factory.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("About structured-data documentation links", () => {
  it("discloses the native Hive market and its conservative CoinGecko dependency in static HTML", () => {
    const html = renderToStaticMarkup(<AboutPageContent />);
    expect(html).toContain("Hive internal market (HBD/HIVE)");
    expect(html).toContain("CoinGecko HIVE/USD conversion dependency");
    expect(html).toContain("not two independent votes");
    expect(html).toContain('href="https://developers.hive.io/apidefinitions/#condenser_api.get_order_book"');
  });
  it("points API and catalog mentions directly at Reference without changing entity identities", () => {
    const html = renderToStaticMarkup(<AboutPageContent />);
    const nodes = Array.from(html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs),
      (match) => JSON.parse(match[1]) as { "@type": string; mentions?: unknown[] });
    const about = nodes.find((node) => node["@type"] === "AboutPage");
    expect(about).toBeDefined();
    expect(about?.mentions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        "@type": "WebAPI",
        "@id": "https://pharos.watch/api/#webapi",
        url: "https://pharos.watch/api/reference/",
      }),
      expect.objectContaining({
        "@type": "DataCatalog",
        "@id": "https://pharos.watch/api/#data-catalog",
        url: "https://pharos.watch/api/reference/",
      }),
    ]));
  });
});

describe("About coverage copy", () => {
  it("claims no per-symbol scan count and counts only unlaunched rows as upcoming", () => {
    const html = renderToStaticMarkup(<AboutPageContent />);
    expect(html).toContain("freeze monitoring across tracked stablecoins");
    expect(html).not.toContain("freeze monitoring across 34 stablecoins");

    const upcoming = PRE_LAUNCH_STABLECOINS.filter((coin) => !isLaunchedAwaitingData(coin)).length;
    expect(upcoming).toBeLessThan(PRE_LAUNCH_STABLECOINS.length);
    expect(html).toContain(`${upcoming} upcoming launches`);
    expect(html).toContain(`${upcoming} upcoming stablecoins`);
    expect(html).not.toContain(`${PRE_LAUNCH_STABLECOINS.length} upcoming launches`);
    expect(html).not.toContain(`${PRE_LAUNCH_STABLECOINS.length} upcoming stablecoins`);
  });
});

describe("About disclosure and reuse copy", () => {
  const POLARIS_SENTENCE =
    "TokenBrice also works on Polaris, and Polaris-related coverage, like everything else on Pharos, remains purely data-driven.";

  it("discloses the owner's Polaris work once inside the team section", () => {
    const html = renderToStaticMarkup(<AboutPageContent />);
    const teamStart = html.indexOf("Who Is Building Pharos?");
    const mediaStart = html.indexOf("Pharos in the media");
    expect(teamStart).toBeGreaterThan(-1);
    expect(mediaStart).toBeGreaterThan(teamStart);
    const teamHtml = html.slice(teamStart, mediaStart);
    expect(teamHtml.split(POLARIS_SENTENCE)).toHaveLength(2);
  });

  it("states the content-type reuse scope with license links and keeps existing contact links", () => {
    const html = renderToStaticMarkup(<AboutPageContent />);
    expect(html).toMatch(
      /are <a [^>]*href="https:\/\/github\.com\/TokenBrice\/pharos-watch\/blob\/main\/LICENSE"[^>]*>MIT-licensed<\/a> and reproducible\./,
    );
    expect(html).toMatch(
      /licensed under <a [^>]*href="https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/"[^>]*>CC BY 4\.0<\/a>\./,
    );
    expect(html).toContain("Third-party material retains its original terms.");
    expect(html).not.toContain("Pharos code, data and data exports are MIT-licensed.");
    expect(html).toContain("Pharos code and data are MIT-licensed.");
    expect(html).toContain('href="mailto:me@tokenbrice.com"');
    expect(html).toContain("Press and research enquiries:");
    expect(html).toContain(">me@tokenbrice.com</a>");
    expect(html).toContain('href="https://github.com/TokenBrice/pharos-watch"');
    expect(html).toContain('href="https://x.com/PharosWatch"');
    expect(html).toContain('href="https://tokenbrice.xyz/"');
  });
});
