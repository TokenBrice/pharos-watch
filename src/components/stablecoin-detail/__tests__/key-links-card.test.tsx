// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { KeyLinksCard } from "@/components/stablecoin-detail/key-links-card";
import type { StablecoinMeta } from "@shared/types";

const meta = {
  id: "test-usd",
  name: "Test USD",
  symbol: "TUSD",
  flags: {
    governance: "centralized",
    backing: "rwa-backed",
    pegCurrency: "USD",
    yieldBearing: false,
    rwa: false,
  },
  links: [
    { label: "Website", url: "https://example.com" },
    { label: "Docs", url: "https://docs.example.com" },
  ],
  proofOfReserves: {
    type: "independent-audit",
    provider: "Deloitte",
    url: "https://example.com/reserves",
  },
} as unknown as StablecoinMeta;

const LATEST_REPORT = {
  periodEnd: "2026-08-31",
  publishedAt: "2026-09-05",
  scope: "assets-and-liabilities",
  liabilityReconciliation: "full",
  reviewer: "test",
  confidence: "verified",
  sources: [{ label: "Report", url: "https://example.com/report" }],
};

function withReport(assuranceMethod: string | null) {
  return {
    ...meta,
    proofOfReserves: {
      ...meta.proofOfReserves!,
      ...(assuranceMethod ? { latestReport: { ...LATEST_REPORT, assuranceMethod } } : {}),
    },
  } as StablecoinMeta;
}


describe("KeyLinksCard", () => {
  it("renders the curated links and the reserve attestation link", () => {
    render(<KeyLinksCard meta={meta} />);

    expect(screen.getByRole("heading", { name: "Key links" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Website" }).getAttribute("href")).toBe("https://example.com");
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("https://docs.example.com");
    expect(screen.getByRole("link", { name: /View reserves/ }).getAttribute("href")).toBe(
      "https://example.com/reserves",
    );
    expect(screen.getByText(/Deloitte/)).toBeTruthy();
    // Without a latest report the storage type may not assert an audit.
    expect(screen.getByText("Independent Report by Deloitte")).toBeTruthy();
  });

  it.each([
    ["examination", "Examination by Deloitte"],
    ["audit", "Audit by Deloitte"],
    ["unknown", "Independent Report by Deloitte"],
    [null, "Independent Report by Deloitte"],
  ])("names the reviewed assurance method (%s)", (method, label) => {
    render(<KeyLinksCard meta={withReport(method)} />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("keeps the provider and reserve source for every report state", () => {
    render(<KeyLinksCard meta={withReport("examination")} />);
    expect(screen.getByText("Examination by Deloitte")).toBeTruthy();
    expect(screen.getByRole("link", { name: /View reserves/ }).getAttribute("href")).toBe(
      "https://example.com/reserves",
    );
  });

  it("drops the attestation block when no proof of reserves is published", () => {
    render(<KeyLinksCard meta={{ ...meta, proofOfReserves: undefined } as StablecoinMeta} />);

    expect(screen.queryByText("Proof of Reserves")).toBeNull();
    expect(screen.getByRole("link", { name: "Website" })).toBeTruthy();
  });

  it("renders nothing when the coin has neither links nor an attestation", () => {
    const { container } = render(
      <KeyLinksCard meta={{ ...meta, links: [], proofOfReserves: undefined } as StablecoinMeta} />,
    );

    expect(container.firstChild).toBeNull();
  });
});
