import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import * as backingRoute from "../backing/[backing]/page";
import * as governanceRoute from "../governance/[governance]/page";
import * as infrastructureRoute from "../infrastructure/[infrastructure]/page";
import StablecoinsHubPage from "../page";
import {
  BACKING_TAXONOMY_PAGES,
  GOVERNANCE_TAXONOMY_PAGE_BY_SLUG,
  GOVERNANCE_TAXONOMY_PAGES,
  INFRASTRUCTURE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";

vi.mock("@/components/stablecoin-filtered-table", () => ({ StablecoinFilteredTable: () => <div /> }));

describe("stablecoin taxonomy hub pages", () => {
  it.each([
    ["backing", "Backing Type Not Found", BACKING_TAXONOMY_PAGES, backingRoute.generateStaticParams, (slug: string) => backingRoute.generateMetadata({ params: Promise.resolve({ backing: slug }) }), (slug: string) => backingRoute.default({ params: Promise.resolve({ backing: slug }) })],
    ["governance", "Governance Type Not Found", GOVERNANCE_TAXONOMY_PAGES, governanceRoute.generateStaticParams, (slug: string) => governanceRoute.generateMetadata({ params: Promise.resolve({ governance: slug }) }), (slug: string) => governanceRoute.default({ params: Promise.resolve({ governance: slug }) })],
    ["infrastructure", "Infrastructure Cohort Not Found", INFRASTRUCTURE_TAXONOMY_PAGES, infrastructureRoute.generateStaticParams, (slug: string) => infrastructureRoute.generateMetadata({ params: Promise.resolve({ infrastructure: slug }) }), (slug: string) => infrastructureRoute.default({ params: Promise.resolve({ infrastructure: slug }) })],
  ] as const)("preserves the %s detail route contract", async (paramKey, missingTitle, pages, staticParams, metadata, Page) => {
    const page = pages[0];

    expect(staticParams()).toEqual(pages.map((entry) => ({ [paramKey]: entry.slug })));
    await expect(metadata(page.slug)).resolves.toMatchObject({
      title: page.title,
      alternates: { canonical: page.href },
      openGraph: { images: [{ url: expect.stringContaining("/og-stablecoins.png") }] },
    });
    await expect(metadata("missing")).resolves.toEqual({
      title: missingTitle,
    });
    expect(renderToStaticMarkup(await Page(page.slug))).toContain(page.title);
  });

  it("names the tracked-profile directory as a stablecoin list, not an active ranking", () => {
    const html = renderToStaticMarkup(<StablecoinsHubPage />);

    expect(html).toContain('id="stablecoin-profile-directory-heading"');
    expect(html).toContain("Stablecoin list");
    expect(html).not.toContain("All Tracked Stablecoin Profiles");
  });

  it("scopes the decentralized governance cohort to Pharos's DeFi classification", async () => {
    const decentralized = GOVERNANCE_TAXONOMY_PAGE_BY_SLUG.get("defi")!;

    expect(decentralized.value).toBe("decentralized");
    expect(decentralized.title).toBe(`Decentralized Stablecoins: ${decentralized.coins.length} Coins Ranked by Risk`);
    expect(decentralized.title.length).toBeLessThanOrEqual(61);
    expect(decentralized.description).toBe(
      `${decentralized.coins.length} stablecoins in Pharos's DeFi governance cohort. Compare peg stability, liquidity, collateral models, and risk profiles.`,
    );
    expect(decentralized.intro).toContain("This cohort uses Pharos's DeFi governance classification");
    expect(decentralized.filterTag).toBe("decentralized");
    expect(decentralized.coins.map((coin) => coin.id)).toEqual(
      ACTIVE_STABLECOINS.filter((coin) => coin.flags.governance === "decentralized").map((coin) => coin.id),
    );

    const html = renderToStaticMarkup(
      await governanceRoute.default({ params: Promise.resolve({ governance: "defi" }) }),
    );
    // Decode the attribute-safe apostrophe React emits so copy assertions read as authored.
    const visibleHtml = html.replaceAll("&#x27;", "'");
    expect(html).toContain(decentralized.title);
    expect(html).toContain("About DeFi stablecoins");
    expect(visibleHtml).toContain(`<p class="pharos-page-deck max-w-3xl">${decentralized.description}</p>`);
    expect(visibleHtml).toContain(`<p class="pharos-lead">${decentralized.intro}</p>`);
    expect(html).not.toContain("DeFi Stablecoins");
  });

  it("compares non-wrapper cohort leaders rather than the first registry variants", async () => {
    const compareIds = (html: string): string[] => {
      const anchor = html.match(/<a[^>]*aria-label="Compare the leading [^"]+ stablecoins"[^>]*>/)?.[0];
      expect(anchor).toBeDefined();
      const href = anchor!.match(/href="([^"]+)"/)?.[1];
      expect(href).toBeDefined();
      expect(href!.startsWith("/compare")).toBe(true);
      const hashIndex = href!.indexOf("#coins=");
      expect(hashIndex).toBeGreaterThan(-1);
      return href!.slice(hashIndex + "#coins=".length).split(",").map(decodeURIComponent);
    };
    const variantOfById = new Map(ACTIVE_STABLECOINS.map((coin) => [coin.id, coin.variantOf ?? null]));

    const cryptoHtml = renderToStaticMarkup(
      await backingRoute.default({ params: Promise.resolve({ backing: "crypto" }) }),
    );
    expect(compareIds(cryptoHtml)).toEqual(["usde-ethena", "usds-sky", "dai-makerdao", "usdf-falcon"]);

    const cefiDependentHtml = renderToStaticMarkup(
      await governanceRoute.default({ params: Promise.resolve({ governance: "cefi-dependent" }) }),
    );
    expect(compareIds(cefiDependentHtml)).toEqual(["usde-ethena", "usds-sky", "dai-makerdao", "usdf-falcon"]);

    const defiIds = compareIds(
      renderToStaticMarkup(await governanceRoute.default({ params: Promise.resolve({ governance: "defi" }) })),
    );
    expect(defiIds).toContain("bold-liquity");
    expect(defiIds).not.toContain("ybold-yearn");
    for (const id of [...compareIds(cryptoHtml), ...compareIds(cefiDependentHtml), ...defiIds]) {
      expect(variantOfById.get(id) ?? null).toBeNull();
    }
  });

});
