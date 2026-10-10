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
  it("renders stablecoin logos for alert-or-higher dots while leaving watch dots plain", () => {
    const { container } = render(
      <DEWSRadarPanel
        logos={{
          "frax-frax": "/logos/frax.svg",
          "usdc-circle": "/logos/usdc.svg",
          "usdt-tether": "/logos/usdt.svg",
          "dai-makerdao": "/logos/dai.svg",
        }}
      />,
    );

    const images = Array.from(container.querySelectorAll("image")).map((image) => image.getAttribute("href"));
    expect(images).toContain("/logos/frax.svg");
    expect(images).toContain("/logos/usdc.svg");
    expect(images).toContain("/logos/usdt.svg");
    expect(images).not.toContain("/logos/dai.svg");
  });

  it("scales logo marks up by escalation tier", () => {
    const { container } = render(
      <DEWSRadarPanel
        logos={{
          "frax-frax": "/logos/frax.svg",
          "usdc-circle": "/logos/usdc.svg",
          "usdt-tether": "/logos/usdt.svg",
        }}
      />,
    );

    const imageWidthByHref = new Map(
      Array.from(container.querySelectorAll("image")).map((image) => [
        image.getAttribute("href"),
        Number(image.getAttribute("width")),
      ]),
    );

    const alertWidth = imageWidthByHref.get("/logos/usdt.svg") ?? 0;
    const warningWidth = imageWidthByHref.get("/logos/usdc.svg") ?? 0;
    const dangerWidth = imageWidthByHref.get("/logos/frax.svg") ?? 0;

    expect(warningWidth).toBeGreaterThan(alertWidth);
    expect(dangerWidth).toBeGreaterThan(warningWidth);
    expect(alertWidth).toBeCloseTo(27, 1);
    expect(warningWidth / alertWidth).toBeCloseTo(1.2, 1);
    expect(dangerWidth / warningWidth).toBeCloseTo(1.2, 1);
  });

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
