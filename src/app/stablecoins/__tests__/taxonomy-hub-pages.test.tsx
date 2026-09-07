import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import StablecoinBackingHubPage, { metadata as backingMetadata } from "../backing/page";
import StablecoinGovernanceHubPage, { metadata as governanceMetadata } from "../governance/page";
import StablecoinInfrastructureHubPage, { metadata as infrastructureMetadata } from "../infrastructure/page";
import * as backingRoute from "../backing/[backing]/page";
import * as governanceRoute from "../governance/[governance]/page";
import * as infrastructureRoute from "../infrastructure/[infrastructure]/page";
import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT } from "@shared/lib/classification";
import {
  BACKING_TAXONOMY_PAGES,
  GOVERNANCE_TAXONOMY_PAGES,
  INFRASTRUCTURE_TAXONOMY_PAGES,
  STABLECOIN_TAXONOMY_HUB_ROUTES,
  getStablecoinTaxonomyHubTotal,
} from "@/lib/stablecoin-taxonomy";

vi.mock("@/components/stablecoin-filtered-table", () => ({ StablecoinFilteredTable: () => <div /> }));

function expectMetadataForRoute(
  metadata: typeof backingMetadata,
  route: (typeof STABLECOIN_TAXONOMY_HUB_ROUTES)[keyof typeof STABLECOIN_TAXONOMY_HUB_ROUTES],
) {
  const description = route.description(getStablecoinTaxonomyHubTotal(route));

  expect(metadata).toMatchObject({
    title: route.title,
    description,
    alternates: { canonical: route.path },
    openGraph: {
      title: route.title,
      description,
      url: route.path,
    },
  });
}

describe("stablecoin taxonomy hub pages", () => {
  it("exports metadata for each taxonomy hub route", () => {
    expectMetadataForRoute(backingMetadata, STABLECOIN_TAXONOMY_HUB_ROUTES.backing);
    expectMetadataForRoute(governanceMetadata, STABLECOIN_TAXONOMY_HUB_ROUTES.governance);
    expectMetadataForRoute(infrastructureMetadata, STABLECOIN_TAXONOMY_HUB_ROUTES.infrastructure);
  });

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

  it("renders backing hub links and JSON-LD item list", () => {
    const html = renderToStaticMarkup(<StablecoinBackingHubPage />);

    expect(html).toContain("Stablecoins by Backing Type");
    expect(html).toContain("Backing type stablecoin hubs");
    expect(html).toContain("/stablecoins/backing/rwa");
    expect(html).toContain("active");
  });

  it("renders governance hub links and JSON-LD item list", () => {
    const html = renderToStaticMarkup(<StablecoinGovernanceHubPage />);

    expect(html).toContain("Stablecoins by Governance Model");
    expect(html).toContain("Governance model stablecoin hubs");
    expect(html).toContain("/stablecoins/governance/cefi");
  });

  it("renders infrastructure hub links and JSON-LD item list", () => {
    const html = renderToStaticMarkup(<StablecoinInfrastructureHubPage />);

    expect(html).toContain("Stablecoins by Shared Infrastructure");
    expect(html).toContain("Shared infrastructure stablecoin hubs");
    expect(html).toContain("/stablecoins/infrastructure/");
  });

  it("keeps long taxonomy hub titles while using canonical short labels", () => {
    const governancePage = STABLECOIN_TAXONOMY_HUB_ROUTES.governance.pages.find(
      (page) => page.value === "centralized-dependent",
    );
    const backingPage = STABLECOIN_TAXONOMY_HUB_ROUTES.backing.pages.find(
      (page) => page.value === "rwa-backed",
    );

    expect(governancePage).toMatchObject({
      shortLabel: GOVERNANCE_LABELS_SHORT["centralized-dependent"],
    });
    expect(governancePage?.title).toContain("CeFi-Dependent Stablecoins");
    expect(backingPage).toMatchObject({
      shortLabel: BACKING_LABELS_SHORT["rwa-backed"],
    });
    expect(backingPage?.title).toContain("RWA-Backed Stablecoins");
  });
});
