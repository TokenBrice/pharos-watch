// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContractDeployments } from "@/components/stablecoin-detail/contract-deployments";
import { CHAIN_META } from "@shared/types/chain-identity";
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.gtag = undefined;
});

describe("ContractDeployments interactions", () => {
  it("selects a contract chain, opens the explorer, and copies the selected address", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    window.gtag = vi.fn();

    const { container } = render(<ContractDeployments coinId={meta.id} contracts={meta.contracts ?? []} />);
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
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Copy Base contract address" })[0]);
    });

    expect(writeText).toHaveBeenCalledWith("0x3333333333333333333333333333333333333333");
    expect(window.gtag).toHaveBeenCalledWith("event", "contract_copied", {
      coin_id: "test-usd",
      chain: "base",
    });
    expect(container.querySelector(".pharos-copy-ring")).not.toBeNull();
  });

  it("selects the exact deployment when one chain has multiple contracts", async () => {
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

    const { container } = render(<ContractDeployments coinId={duplicateChainMeta.id} contracts={duplicateChainMeta.contracts ?? []} />);
    const mobileGrid = container.querySelector(".grid.grid-cols-5");
    expect(mobileGrid).not.toBeNull();

    fireEvent.click(within(mobileGrid as HTMLElement).getByRole("button", { name: /Base contract 0xbbbb/i }));

    const selectedContract = screen.getByText("Selected contract").closest("div");
    expect(selectedContract).not.toBeNull();
    expect(within(selectedContract as HTMLElement).getByText("0xbbbb...bbbb")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Copy Base contract address" })[0]);
    });

    expect(writeText).toHaveBeenCalledWith("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it.each(["unavailable", "failing"] as const)(
    "does not report copy success when writeText rejects and legacy copy is %s",
    async (legacyCopy) => {
      const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const execCommand = vi.fn().mockReturnValue(false);
      const previousExecCommand = document.execCommand;
      Object.defineProperty(document, "execCommand", {
        configurable: true, value: legacyCopy === "failing" ? execCommand : undefined,
      });
      window.gtag = vi.fn();
      try {
        const { container } = render(<ContractDeployments coinId={meta.id} contracts={meta.contracts ?? []} />);
        await act(async () => {
          fireEvent.click(screen.getAllByRole("button", { name: "Copy Ethereum contract address" })[0]);
        });
        expect(writeText).toHaveBeenCalledWith(contracts[0][1]);
        if (legacyCopy === "failing") expect(execCommand).toHaveBeenCalledWith("copy");
        expect(container.querySelector(".pharos-copy-ring")).toBeNull();
        expect(container.querySelector(".lucide-check.opacity-100")).toBeNull();
        expect(window.gtag).not.toHaveBeenCalledWith("event", "contract_copied", expect.anything());
      } finally {
        Object.defineProperty(document, "execCommand", { configurable: true, value: previousExecCommand });
      }
    },
  );

  it("renders desktop labeled contract rows with address, copy, and explorer actions", () => {
    render(<ContractDeployments coinId={meta.id} contracts={meta.contracts ?? []} />);

    // Each deployment gets a labeled row: chain link + truncated address +
    // copy button + explorer link.
    expect(screen.getAllByRole("link", { name: "Arbitrum" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("0x2222...2222")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Arbitrum contract address" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View Arbitrum contract on explorer" }).getAttribute("href"),
    ).toBe("https://arbiscan.io/address/0x2222222222222222222222222222222222222222");
    // 7 contracts fit the 9-row desktop preview: the in-flow card has no
    // show-all toggle any more, only the closed `Contract addresses` fold.
    expect(screen.queryAllByRole("button", { name: "Show all 7 chains" })).toHaveLength(0);
  });

});

const manyContracts = [
  { chain: "ethereum", address: "0xa000000000000000000000000000000000000001", decimals: 18 },
  { chain: "ethereum", address: "0xa000000000000000000000000000000000000002", decimals: 18 },
  { chain: "ethereum", address: "0xa000000000000000000000000000000000000003", decimals: 18 },
  { chain: "ethereum", address: "0xa000000000000000000000000000000000000004", decimals: 18 },
  { chain: "ethereum", address: "0xa000000000000000000000000000000000000005", decimals: 6 },
  { chain: "ethereum", address: "0xa000000000000000000000000000000000000006", decimals: 18 },
  { chain: "base", address: "0xb000000000000000000000000000000000000001", decimals: 18 },
  { chain: "base", address: "0xb000000000000000000000000000000000000002", decimals: 18 },
  { chain: "base", address: "0xb000000000000000000000000000000000000003", decimals: 18 },
  { chain: "base", address: "0xb000000000000000000000000000000000000004", decimals: 18 },
  { chain: "solana", address: "So11111111111111111111111111111111111111112", decimals: 9 },
  { chain: "injective", address: "factory/inj1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/inj1bb", decimals: null, kind: "native-denom" },
] as unknown as NonNullable<StablecoinMeta["contracts"]>;

function foldRows(container: ParentNode) {
  return [...container.querySelectorAll<HTMLElement>("details[data-module-fold] li")];
}

describe("ContractDeployments complete address list", () => {
  it("renders every recorded deployment as closed plain text, including the last row", () => {
    const markup = renderToStaticMarkup(
      <ContractDeployments coinId={meta.id} contracts={manyContracts} />,
    );

    expect(markup).toContain("Contract addresses");
    expect(markup).toContain("(12)");
    // Closed by default: the fold carries no `open` attribute until asked.
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:[=\s>])/);

    for (const contract of manyContracts) {
      const chainName = CHAIN_META[contract.chain]?.name ?? contract.chain;
      expect(markup).toContain(`>${chainName} ${contract.address}<`);
    }

    const list = markup.slice(markup.indexOf("<ul"), markup.indexOf("</ul>") + "</ul>".length);
    expect(list).toContain("Injective factory/inj1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/inj1bb");
    // Compact static rows only: two interactive mounts for USDC's 88
    // deployments measured ~1.26 MB, so one row stays a text line.
    expect(list.length / manyContracts.length).toBeLessThan(150);
    expect(list).not.toContain("<button");
    expect(list).not.toContain("<svg");
    // Plain rows: no per-deployment ids or rail twins to resolve.
    expect(list).not.toContain(" id=");
    expect(list).not.toContain("data-anchor-twin");
  });

  it("renders the plain list once, only in the in-flow card", () => {
    const { container } = render(
      <>
        <ContractDeployments coinId={meta.id} contracts={manyContracts} compact />
        <ContractDeployments coinId={meta.id} contracts={manyContracts} />
      </>,
    );

    const folds = container.querySelectorAll("details[data-module-fold]");
    expect(folds).toHaveLength(1);
    expect(foldRows(container)).toHaveLength(manyContracts.length);
    expect(container.querySelectorAll("[id^='contract-']")).toHaveLength(0);
    expect(container.querySelectorAll("li[data-anchor-twin]")).toHaveLength(0);
    // The card's own `#contracts` owner stays single across responsive mounts.
    expect(container.querySelectorAll("#contracts")).toHaveLength(1);
  });

  it("keeps every row mounted while the disclosure opens and closes", () => {
    const { container } = render(<ContractDeployments coinId={meta.id} contracts={manyContracts} />);
    const disclosure = container.querySelector<HTMLDetailsElement>("details[data-module-fold]");
    expect(disclosure).not.toBeNull();
    expect(disclosure!.open).toBe(false);

    disclosure!.open = true;
    fireEvent(disclosure!, new Event("toggle"));
    expect(foldRows(container)).toHaveLength(manyContracts.length);

    disclosure!.open = false;
    fireEvent(disclosure!, new Event("toggle"));
    expect(foldRows(container)).toHaveLength(manyContracts.length);
  });

  it("keeps the rail show-all toggle and adds no fold there", () => {
    const { container } = render(<ContractDeployments coinId={meta.id} contracts={manyContracts} compact />);

    expect(container.querySelectorAll("details[data-module-fold]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Copy Injective contract address" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 12 contract deployments" }));
    expect(screen.getByRole("button", { name: "Collapse contract deployments" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Injective contract address" })).toBeTruthy();
  });

  it("renders no card for an empty contract list", () => {
    expect(renderToStaticMarkup(<ContractDeployments coinId={meta.id} contracts={[]} />)).toBe("");
  });

  it("still offers the full address fold for a single deployment", () => {
    const single = [{ chain: "ethereum", address: "0xcccccccccccccccccccccccccccccccccccccccc", decimals: 18 }] as NonNullable<
      StablecoinMeta["contracts"]
    >;
    const markup = renderToStaticMarkup(<ContractDeployments coinId={meta.id} contracts={single} />);

    expect(markup).toContain("Contract addresses");
    expect(markup).toContain("(1)");
    expect(markup).toContain(">Ethereum 0xcccccccccccccccccccccccccccccccccccccccc<");
  });
});
