import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import StablecoinBackingHubPage from "../backing/page";
import StablecoinGovernanceHubPage from "../governance/page";
import StablecoinInfrastructureHubPage from "../infrastructure/page";

describe("stablecoin taxonomy hub pages", () => {
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
