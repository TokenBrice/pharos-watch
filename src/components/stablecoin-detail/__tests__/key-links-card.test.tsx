// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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


describe("KeyLinksCard", () => {
  it("renders the curated links and the reserve attestation link", () => {
    render(<KeyLinksCard meta={meta} />);

    expect(screen.getByRole("heading", { name: "Key Links" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Website" }).getAttribute("href")).toBe("https://example.com");
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("https://docs.example.com");
    expect(screen.getByRole("link", { name: /View reserves/ }).getAttribute("href")).toBe(
      "https://example.com/reserves",
    );
    expect(screen.getByText(/Deloitte/)).toBeTruthy();
  });

  it("owns #attestation only in the anchored in-flow copy, and marks the rail copy as its twin", () => {
    const { container: inFlow } = render(<KeyLinksCard meta={meta} anchors />);
    expect(inFlow.querySelector("#attestation")).not.toBeNull();
    expect(inFlow.querySelector('[data-anchor-twin="attestation"]')).toBeNull();
    cleanup();

    const { container: rail } = render(<KeyLinksCard meta={meta} />);
    expect(rail.querySelector("#attestation")).toBeNull();
    expect(rail.querySelector('[data-anchor-twin="attestation"]')).not.toBeNull();
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
