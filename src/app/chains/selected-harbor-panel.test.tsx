// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { SelectedHarborPanel } from "./selected-harbor-panel";
import type { ChainHarborEntry } from "./harbor-map";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) =>
    createElement("img", { ...props, alt: props.alt ?? "" }),
}));

describe("SelectedHarborPanel", () => {
  it("renders exact selected harbor supply, health, cargo, and wake fields", () => {
    const entry: ChainHarborEntry = {
      id: "ethereum",
      name: "Ethereum",
      logoPath: "/logos/chains/ethereum.svg",
      darkInvert: false,
      totalUsd: 72_000_000_000,
      sharePct: 42.34,
      berthPct: 100,
      healthScore: 86,
      healthBand: "robust",
      stablecoinCount: 34,
      dominantId: "usdc-circle",
      dominantSymbol: "USDC",
      dominantSharePct: 52.4,
      dominantCargoUsd: 37_700_000_000,
      cargos: [
        { id: "usdc-circle", symbol: "USDC", sharePct: 52.4, cargoUsd: 37_700_000_000 },
        { id: "usdt-tether", symbol: "USDT", sharePct: 31.2, cargoUsd: 22_400_000_000 },
      ],
      change7dPct: 0.0123,
    };

    render(createElement(SelectedHarborPanel, { entry }));

    expect(screen.getByRole("heading", { name: "Ethereum" })).toBeTruthy();
    expect(screen.getByText("86 robust")).toBeTruthy();
    expect(screen.getByText("42.34% of tracked supply")).toBeTruthy();
    expect(screen.getByText("34")).toBeTruthy();
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    expect(screen.getByText("52.4%")).toBeTruthy();
    expect(document.querySelector('img[src="/logos/2-usdc.svg"]')).toBeTruthy();
    expect(document.querySelector('img[src="/logos/1-usdt.svg"]')).toBeTruthy();
    expect(screen.getByText(/not issuer redemption capacity/i)).toBeTruthy();
  });
});
