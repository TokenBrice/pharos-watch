// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { DEWSRadarPanel } from "@/components/dews-summary";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";
import { makeStablecoin } from "@shared/test-utils/stablecoin";

const useStablecoinsMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useStressSignals: () => ({
    data: {
      updatedAt: 1_775_898_800,
      signals: {
        "frax-frax": { score: 88, band: "DANGER" },
        "usdc-circle": { score: 68, band: "WARNING" },
        "usdt-tether": { score: 42, band: "ALERT" },
        "dai-makerdao": { score: 25, band: "WATCH" },
      },
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

beforeEach(() => {
  installMatchMediaMock(true);
  useStablecoinsMock.mockReturnValue({ data: undefined });
});
afterEach(cleanupFrontendTest);


describe("DEWSRadarPanel radar logos", () => {
  it("announces unavailable supply without turning it into the observed-zero size tier", () => {
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [
      makeStablecoin({ id: "usdc-circle", circulating: {} }),
      makeStablecoin({ id: "usdt-tether", circulating: { peggedUSD: 0 } }),
    ] } });
    const { getByRole, getByText } = render(<DEWSRadarPanel />);
    const missing = getByRole("button", { name: /USDC.*supply unavailable/ });
    const zero = getByRole("button", { name: /USDT.*\$0.*market cap/ });
    expect(missing.getAttribute("aria-label")).not.toContain("$0");
    expect(zero.getAttribute("aria-label")).not.toContain("supply unavailable");
    fireEvent.focus(missing);
    expect(getByText("Supply unavailable")).toBeTruthy();
  });
});

describe("DEWSRadarPanel open-incident halos", () => {
  it("describes a haloed coin as having an open confirmed incident, not a live depeg", () => {
    const { getByRole, getByText } = render(<DEWSRadarPanel activeDepegIds={new Set(["usdc-circle"])} />);
    expect(getByRole("button", { name: /USDC.*with an open confirmed incident/ })).toBeTruthy();
    expect(getByText("Elevated, open confirmed incident (1)")).toBeTruthy();
    expect(getByRole("button", { name: /FRAX/ }).getAttribute("aria-label")).not.toContain("incident");
  });
});
