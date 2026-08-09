// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { KeyInfoCard } from "@/components/key-info-card-root";
import { ContractDeployments } from "@/components/key-info-card/contract-deployments";
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

    // Two matches: the mobile quick row and the desktop labeled row.
    fireEvent.click(screen.getAllByRole("button", { name: "Copy Base contract address" })[0]);

    expect(writeText).toHaveBeenCalledWith("0x3333333333333333333333333333333333333333");
    expect(window.gtag).toHaveBeenCalledWith("event", "contract_copied", {
      coin_id: "test-usd",
      chain: "base",
    });
  });

  it("selects the exact deployment when one chain has multiple contracts", () => {
    vi.useFakeTimers();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const duplicateChainMeta = {
      ...meta,
      contracts: [
        { chain: "base", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { chain: "base", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      ],
    } as StablecoinMeta;

    const { container } = render(<KeyInfoCard meta={duplicateChainMeta} resolvedMechanismArchetype={null} />);
    const mobileGrid = container.querySelector(".grid.grid-cols-5");
    expect(mobileGrid).not.toBeNull();

    fireEvent.click(within(mobileGrid as HTMLElement).getByRole("button", { name: /Base contract 0xbbbb/i }));

    const selectedContract = screen.getByText("Selected contract").closest("div");
    expect(selectedContract).not.toBeNull();
    expect(within(selectedContract as HTMLElement).getByText("0xbbbb...bbbb")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Copy Base contract address" })[0]);

    expect(writeText).toHaveBeenCalledWith("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("clears the contract-copy feedback timer on unmount", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn() },
    });

    const { unmount } = render(<KeyInfoCard meta={meta} resolvedMechanismArchetype={null} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy Ethereum contract address" })[0]);

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

  it("renders desktop labeled contract rows with address, copy, and explorer actions", () => {
    render(<KeyInfoCard meta={meta} resolvedMechanismArchetype={null} />);

    // Each deployment gets a labeled row: chain link + truncated address +
    // copy button + explorer link.
    expect(screen.getAllByRole("link", { name: "Arbitrum" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("0x2222...2222")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Arbitrum contract address" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View Arbitrum contract on explorer" }).getAttribute("href"),
    ).toBe("https://arbiscan.io/address/0x2222222222222222222222222222222222222222");
    // 7 contracts fit the 9-row desktop preview: only the mobile Show-all
    // (6-item preview) renders, not a second desktop toggle.
    expect(screen.getAllByRole("button", { name: "Show all 7 chains" }).length).toBe(1);
  });

  it("renders compact contract rail rows with a header count and icon-only expander", () => {
    render(<ContractDeployments coinId={meta.id} contracts={meta.contracts ?? []} compact />);

    expect(screen.getByRole("heading", { name: "Contracts" })).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("Ethereum")).toBeTruthy();
    expect(screen.getByText("0x1111...1111")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Ethereum contract address" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View Ethereum contract on explorer" }).getAttribute("href"),
    ).toBe("https://etherscan.io/address/0x1111111111111111111111111111111111111111");
    expect(screen.queryByText("BSC")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show all 7 contract deployments" }));

    expect(screen.getByText("BSC")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse contract deployments" })).toBeTruthy();
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

  it("renders the Launched proof line only for valid launch dates", () => {
    render(
      <KeyInfoCard
        meta={{ ...meta, launchDate: "2018-09-26" } as StablecoinMeta}
        resolvedMechanismArchetype={null}
      />,
    );
    expect(screen.getByText("Launched")).toBeTruthy();
    expect(screen.getByText("September 26, 2018")).toBeTruthy();
    cleanup();

    // Absent or malformed dates omit the line (passport omit-when-absent rule).
    render(<KeyInfoCard meta={{ ...meta, launchDate: "2018-13-45" } as StablecoinMeta} resolvedMechanismArchetype={null} />);
    expect(screen.queryByText("Launched")).toBeNull();
  });
});
