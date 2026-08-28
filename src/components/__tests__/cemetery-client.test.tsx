// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ImgHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({
  default: ({ alt, ...props }: ImgHTMLAttributes<HTMLImageElement>) => <img alt={alt} {...props} />,
}));

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("@shared/lib/dead-stablecoins", () => ({
  CAUSE_HEX: {
    "algorithmic-failure": "#ef4444",
    "counterparty-failure": "#f59e0b",
    "liquidity-drain": "#f97316",
    regulatory: "#3b82f6",
    abandoned: "#71717a",
  },
  CAUSE_META: {
    "algorithmic-failure": { label: "Algorithmic Failure", textColor: "text-red-700", borderColor: "border-red-500/30" },
    "counterparty-failure": { label: "Counterparty Failure", textColor: "text-amber-700", borderColor: "border-amber-500/30" },
    "liquidity-drain": { label: "Liquidity Drain", textColor: "text-orange-700", borderColor: "border-orange-500/30" },
    regulatory: { label: "Regulatory", textColor: "text-blue-700", borderColor: "border-blue-500/30" },
    abandoned: { label: "Abandoned", textColor: "text-zinc-700", borderColor: "border-zinc-500/30" },
  },
  DEAD_STABLECOINS: [
    {
      id: "usdl-first-usdl-2024-01",
      name: "First USDL",
      symbol: "USDL",
      pegCurrency: "USD",
      causeOfDeath: "liquidity-drain",
      deathDate: "2024-01",
      logo: "/logos/239-eurr.png",
      obituary: "First obituary.",
      sourceUrl: "https://example.com/first",
      sourceLabel: "Example",
    },
    {
      id: "usdl-second-usdl-2025-01",
      name: "Second USDL",
      symbol: "USDL",
      pegCurrency: "USD",
      causeOfDeath: "abandoned",
      deathDate: "2025-01",
      obituary: "Second obituary.",
      sourceUrl: "https://example.com/second",
      sourceLabel: "Example",
    },
  ],
}));

import { CemeteryClient } from "../cemetery-client";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";

describe("CemeteryClient", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps duplicate-symbol cemetery rows independent by dead-coin id", () => {
    render(<CemeteryClient entries={DEAD_STABLECOINS} />);

    fireEvent.click(screen.getAllByRole("button", { name: /First USDL/ })[0]!);

    const firstAutopsy = document.getElementById("autopsy-usdl-first-usdl-2024-01");
    const secondAutopsy = document.getElementById("autopsy-usdl-second-usdl-2025-01");

    expect((firstAutopsy as HTMLElement | null)?.style.gridTemplateRows).toBe("1fr");
    expect((secondAutopsy as HTMLElement | null)?.style.gridTemplateRows).toBe("0fr");

    fireEvent.click(screen.getAllByRole("button", { name: /Second USDL/ })[0]!);

    expect(document.getElementById("obituary-usdl-second-usdl-2025-01")?.className).toContain("ring-2");
    expect(document.getElementById("obituary-usdl-first-usdl-2024-01")?.className).not.toContain("ring-2");
  });

  it("pays respects once when F is pressed on a focused tombstone", () => {
    render(<CemeteryClient entries={DEAD_STABLECOINS} />);

    const tombstone = screen.getAllByRole("button", { name: /First USDL/ })[0]!;
    tombstone.focus();
    fireEvent.keyDown(tombstone, { key: "F" });

    expect(document.querySelectorAll("svg.animate-in")).toHaveLength(1);
  });

  it("renders absolute cemetery logo paths without the cemetery prefix", () => {
    render(<CemeteryClient entries={DEAD_STABLECOINS} />);

    expect(screen.getByAltText("First USDL logo").getAttribute("src")).toBe("/logos/239-eurr.png");
    expect(screen.getByAltText("USDL").getAttribute("src")).toBe("/logos/239-eurr.png");
  });
});
