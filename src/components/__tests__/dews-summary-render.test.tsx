// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { DEWSSummary } from "@/components/dews-summary";
import { installMatchMediaMock } from "@/test-utils/frontend";

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
  useStablecoins: () => ({ data: undefined }),
}));

beforeAll(() => {
  installMatchMediaMock(true);
});


describe("DEWSSummary radar logos", () => {
  it("renders stablecoin logos for alert-or-higher dots while leaving watch dots plain", () => {
    const { container } = render(
      <DEWSSummary
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
      <DEWSSummary
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
});
