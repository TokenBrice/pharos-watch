// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllTrackingTimers } from "@/lib/analytics";

// Fixture rows with distinct regimes let the client test prove that status and
// token-type filters never narrow the inactive, hidden panel's model.
const fixtures = vi.hoisted(() => {
  const metas = [
    { id: "euro-emt", name: "Euro EMT", symbol: "EEMT", status: "active", flags: { pegCurrency: "EUR" } },
    { id: "art-basket", name: "Basket Reference", symbol: "BSKT", status: "active", flags: { pegCurrency: "EUR" } },
    { id: "dollar-intent", name: "Dollar Intent", symbol: "DINT", status: "active", flags: { pegCurrency: "USD" } },
    { id: "dollar-qualified", name: "Dollar Qualified", symbol: "DQLF", status: "active", flags: { pegCurrency: "USD" } },
  ];
  const compliance = [
    {
      id: "euro-emt",
      mica: {
        status: "authorized",
        tokenType: "EMT",
        authorizationType: "emi",
        competentAuthority: "BaFin",
        authorizedEntity: "Euro Issuer SA",
        references: [{ label: "Authorization notice", url: "https://bafin.example/notice" }],
      },
    },
    {
      id: "art-basket",
      mica: { status: "non-compliant", tokenType: "ART", competentAuthority: "AMF" },
    },
    {
      id: "dollar-intent",
      genius: {
        authorizationStatus: "issuer-announced-intent",
        applicability: "in-scope",
        issuerPathway: "state-qualified",
        issuerEntity: "Intent Labs Inc",
        primaryFederalRegulator: "OCC",
        reviewedAt: "2026-09-15",
      },
    },
    {
      id: "dollar-qualified",
      genius: {
        authorizationStatus: "state-qualified",
        applicability: "in-scope",
        issuerPathway: "state-qualified",
        issuerEntity: "Qualified Labs Inc",
        reviewedAt: "2026-09-20",
      },
    },
  ];
  return { metas, compliance };
});

vi.mock("@shared/data/stablecoins/coins.compliance.generated.json", () => ({
  default: fixtures.compliance,
}));
vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_TRACKED_STABLECOINS: fixtures.metas,
}));
vi.mock("@shared/lib/stablecoins/client-detail", () => ({
  loadClientStablecoinDetail: vi.fn(),
}));
vi.mock("@shared/lib/compliance-regime-state", () => ({
  GENIUS_REGIME_STATE: { rulemakingPhase: "proposed-rules" },
  isGeniusRegimeEffective: () => false,
}));

import { ComplianceClient } from "@/components/compliance/compliance-client";

function panel(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}

describe("Compliance client regime isolation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/compliance/");
  });

  afterEach(() => {
    cleanup();
    clearAllTrackingTimers();
  });

  it("keeps the inactive MiCA panel unfiltered while GENIUS owns status and type", async () => {
    window.history.replaceState(null, "", "/compliance/?regime=genius&status=issuer-announced-intent&type=ART");
    render(<ComplianceClient />);

    await screen.findByRole("region", { name: "Compliance data" });

    const geniusText = panel("compliance-genius-panel").textContent ?? "";
    // Only the selected GENIUS status is filtered; GENIUS never takes a type.
    expect(geniusText).toContain("Dollar Intent");
    expect(geniusText).not.toContain("Dollar Qualified");

    const micaText = panel("compliance-mica-panel").textContent ?? "";
    expect(micaText).toContain("Euro EMT");
    expect(micaText).toContain("Basket Reference");
  });

  it("keeps the inactive GENIUS panel unfiltered while MiCA owns status and type", async () => {
    window.history.replaceState(null, "", "/compliance/?regime=mica&status=authorized&type=EMT");
    render(<ComplianceClient />);

    await screen.findByRole("region", { name: "Compliance data" });

    const micaText = panel("compliance-mica-panel").textContent ?? "";
    expect(micaText).toContain("Euro EMT");
    expect(micaText).not.toContain("Basket Reference");

    await waitFor(() => expect(panel("compliance-genius-panel").textContent).toContain("Dollar Intent"));
    const geniusText = panel("compliance-genius-panel").textContent ?? "";
    expect(geniusText).toContain("Dollar Qualified");
  });

  it("uses the selected regime's unfiltered row total as the workbench denominator", async () => {
    window.history.replaceState(null, "", "/compliance/?regime=mica");
    render(<ComplianceClient />);
    await screen.findByRole("region", { name: "Compliance data" });
    await waitFor(() => expect(document.querySelector(".pharos-table-toolbar")?.textContent).toContain("2 assessed regime rows"));
    expect(document.querySelector(".pharos-table-toolbar")?.textContent).not.toContain("2/4 matching");

    cleanup();
    window.history.replaceState(null, "", "/compliance/?regime=mica&status=authorized");
    render(<ComplianceClient />);
    await screen.findByRole("region", { name: "Compliance data" });
    await waitFor(() => expect(document.querySelector(".pharos-table-toolbar")?.textContent).toContain("1/2 matching"));
    expect(document.querySelector(".pharos-table-toolbar")?.textContent).not.toContain("1/4 matching");
  });
});
