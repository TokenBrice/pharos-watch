// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { KeyInfoCard } from "@/components/key-info-card";
import type { StablecoinMeta } from "@shared/types";

vi.mock("next/image", () => ({
  default: ({ alt = "", ...props }: { alt?: string; [key: string]: unknown }) => (
    <img alt={alt} {...props} />
  ),
}));

const contracts = [
  ["ethereum", "0x1111111111111111111111111111111111111111"],
  ["arbitrum", "0x2222222222222222222222222222222222222222"],
  ["base", "0x3333333333333333333333333333333333333333"],
  ["optimism", "0x4444444444444444444444444444444444444444"],
  ["polygon", "0x5555555555555555555555555555555555555555"],
  ["avalanche", "0x6666666666666666666666666666666666666666"],
  ["bsc", "0x7777777777777777777777777777777777777777"],
] as const;

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
  collateral: "Cash and short-duration Treasuries.",
  pegMechanism: "Issuer redemption at par.",
  links: [],
  contracts: contracts.map(([chain, address]) => ({ chain, address })),
} as unknown as StablecoinMeta;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.gtag = undefined;
});

describe("KeyInfoCard contract interactions", () => {
  it("selects a contract chain, opens the explorer, and copies the selected address", () => {
    vi.useFakeTimers();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    window.gtag = vi.fn();

    const { container } = render(<KeyInfoCard meta={meta} resolvedMechanismArchetype={null} />);
    const mobileGrid = container.querySelector(".grid.grid-cols-5");
    expect(mobileGrid).not.toBeNull();

    expect(screen.getByText("7 deployments tracked across Ethereum, Arbitrum, Base, and Optimism, plus 3 more.")).toBeTruthy();

    fireEvent.click(within(mobileGrid as HTMLElement).getByRole("button", { name: /Base contract 0x3333/i }));

    const selectedContract = screen.getByText("Selected contract").closest("div");
    expect(selectedContract).not.toBeNull();
    expect(within(selectedContract as HTMLElement).getByText("Base")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "View on Base explorer" })[0]?.getAttribute("href")).toBe(
      "https://basescan.org/address/0x3333333333333333333333333333333333333333",
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy Base contract address" }));

    expect(writeText).toHaveBeenCalledWith("0x3333333333333333333333333333333333333333");
    expect(window.gtag).toHaveBeenCalledWith("event", "contract_copied", {
      coin_id: "test-usd",
      chain: "base",
    });
  });

  it("clears the contract-copy feedback timer on unmount", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn() },
    });

    const { unmount } = render(<KeyInfoCard meta={meta} resolvedMechanismArchetype={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy Ethereum contract address" }));

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("hides overflow mobile contracts again and clears a hidden selected chain", () => {
    const { container } = render(<KeyInfoCard meta={meta} resolvedMechanismArchetype={null} />);
    const mobileGrid = container.querySelector(".grid.grid-cols-5");
    expect(mobileGrid).not.toBeNull();

    expect(within(mobileGrid as HTMLElement).queryByRole("button", { name: /BSC contract/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show all 7 chains" }));
    fireEvent.click(within(mobileGrid as HTMLElement).getByRole("button", { name: /BSC contract 0x7777/i }));
    expect(screen.getByText("Selected contract")).toBeTruthy();
    expect(screen.getAllByText("BSC").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));

    expect(within(mobileGrid as HTMLElement).queryByRole("button", { name: /BSC contract/i })).toBeNull();
    expect(screen.queryByText("Selected contract")).toBeNull();
    expect(screen.getByText("Primary contract")).toBeTruthy();
  });

  it("links MiCA badges to the tracker and marks frozen statuses as historical", () => {
    render(
      <KeyInfoCard
        meta={{
          ...meta,
          status: "frozen",
          mica: {
            status: "authorized",
          },
        } as StablecoinMeta}
        resolvedMechanismArchetype={null}
      />,
    );

    const link = screen.getByRole("link", { name: /Historical MiCA status: Authorized/i });
    expect(link.getAttribute("href")).toBe("/compliance?regime=mica");
    expect(screen.getByText("Historical MiCA: Authorized")).toBeTruthy();
  });
});
