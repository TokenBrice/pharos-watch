// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeroPassportMrzViewModel } from "@/lib/stablecoin-detail-mrz";
import { HeroPassportMrz } from "../hero-passport-mrz";

const MRZ: HeroPassportMrzViewModel = {
  lines: [
    `PW<USA<USD<COIN${"<".repeat(29)}`,
    "USDC<<<USDBP076093072016151YCCASH1809263<<<<",
  ],
  copyText:
    "USDC (USD Coin, launched 2018) — Pharos Safety B+ (76/100) · Peg 93 · Liquidity 72 · " +
    "DEWS 16/100 (Watch) · Custodial cash · United States jurisdiction · Freeze: yes · " +
    "151 chains — https://pharos.watch/stablecoin/usd-coin/",
  ariaLabel: "Copy USDC research summary: Safety B+ 76 of 100, peg 93, liquidity 72, DEWS 16 of 100",
};

const mockWriteText = vi.fn().mockResolvedValue(undefined);

describe("HeroPassportMrz", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    mockWriteText.mockClear();
  });

  it("renders both MRZ lines aria-hidden inside a button named by the aria label", () => {
    const { getByRole } = render(<HeroPassportMrz mrz={MRZ} />);

    const button = getByRole("button", { name: MRZ.ariaLabel });
    const hiddenLines = Array.from(button.querySelectorAll('[aria-hidden="true"]'));
    expect(hiddenLines.map((line) => line.textContent)).toEqual(MRZ.lines);
    expect(hiddenLines.every((line) => line.className.includes("font-mono"))).toBe(true);
    expect(button.textContent).toContain("Copy summary");
  });

  it("copies the research citation on click and swaps the micro-label to COPIED", async () => {
    const { getByRole } = render(<HeroPassportMrz mrz={MRZ} />);

    const button = getByRole("button", { name: MRZ.ariaLabel });
    fireEvent.click(button);

    expect(mockWriteText).toHaveBeenCalledWith(MRZ.copyText);
    await vi.waitFor(() => {
      expect(button.textContent).toContain("Copied");
    });
    expect(button.textContent).not.toContain("Copy summary");
  });

  it("survives a missing clipboard API without crashing", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    const { getByRole } = render(<HeroPassportMrz mrz={MRZ} />);

    const button = getByRole("button", { name: MRZ.ariaLabel });
    expect(() => fireEvent.click(button)).not.toThrow();
    expect(button.textContent).toContain("Copy summary");
  });
});
