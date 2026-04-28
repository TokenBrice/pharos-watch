import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import StablecoinBackingHubPage, { metadata as backingMetadata } from "../backing/page";
import StablecoinGovernanceHubPage, { metadata as governanceMetadata } from "../governance/page";
import StablecoinInfrastructureHubPage, { metadata as infrastructureMetadata } from "../infrastructure/page";
import { STABLECOIN_TAXONOMY_HUB_ROUTES, getStablecoinTaxonomyHubTotal } from "@/lib/stablecoin-taxonomy";

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
});
