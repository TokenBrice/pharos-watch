// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportCard, StablecoinMeta } from "@shared/types";

const { isHeroVerdictEnabledMock } = vi.hoisted(() => ({
  isHeroVerdictEnabledMock: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isHeroVerdictEnabled: isHeroVerdictEnabledMock,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/bluechip-header-badge", () => ({
  BluechipHeaderBadge: () => null,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>logo:{name}</span>,
}));

import { HeroDesktopIdentity, HeroMobileIdentity, HeroVerdict } from "../hero-card-identity";

const BASE_COIN: StablecoinMeta = {
  id: "usdc-circle",
  symbol: "USDC",
  name: "USD Coin",
  flags: {
    backing: "rwa-backed",
    governance: "centralized",
    pegCurrency: "USD",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  },
  mechanismArchetype: "fiat-cash",
};

const INSTITUTIONAL_REPORT_CARD = {
  overallGrade: "A",
  rawInputs: { canBeBlacklisted: false },
} as unknown as ReportCard;

const COMMON_PROPS = {
  infrastructures: [],
  reportCard: null,
  variantParent: null,
  variantChipClass: null,
  logoSrc: undefined,
} as const;

describe("HeroVerdict standalone (mobile section)", () => {
  beforeEach(() => {
    isHeroVerdictEnabledMock.mockReset();
  });
  afterEach(cleanup);

  it("renders the verdict pill when the flag is on and the archetype is categorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(
      <HeroVerdict coin={BASE_COIN} reportCard={INSTITUTIONAL_REPORT_CARD} />,
    );

    const verdictEl = container.querySelector(`#hero-verdict-${BASE_COIN.id}`);
    expect(verdictEl).not.toBeNull();
    expect(verdictEl?.getAttribute("data-archetype")).toBe("institutional-default");
    expect(verdictEl?.textContent).toBe("Institutional Default");
  });

  it("renders nothing when the archetype is uncategorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    // No report card and no mechanism context for the test coin → uncategorized.
    const uncategorizedCoin: StablecoinMeta = { ...BASE_COIN, mechanismArchetype: undefined };
    const { container } = render(<HeroVerdict coin={uncategorizedCoin} />);

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the flag is off", () => {
    isHeroVerdictEnabledMock.mockReturnValue(false);

    const { container } = render(
      <HeroVerdict coin={BASE_COIN} reportCard={INSTITUTIONAL_REPORT_CARD} />,
    );

    expect(container.firstChild).toBeNull();
  });
});

describe("HeroMobileIdentity heading aria-describedby", () => {
  beforeEach(() => {
    isHeroVerdictEnabledMock.mockReset();
  });
  afterEach(cleanup);

  it("wires aria-describedby when the flag is on and the archetype is categorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(
      <HeroMobileIdentity coin={BASE_COIN} {...COMMON_PROPS} reportCard={INSTITUTIONAL_REPORT_CARD} />,
    );

    const heading = container.querySelector("h2");
    expect(heading?.getAttribute("aria-describedby")).toBe(`hero-verdict-${BASE_COIN.id}`);
  });

  it("omits aria-describedby when the archetype is uncategorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const uncategorizedCoin: StablecoinMeta = { ...BASE_COIN, mechanismArchetype: undefined };
    const { container } = render(<HeroMobileIdentity coin={uncategorizedCoin} {...COMMON_PROPS} />);

    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("omits aria-describedby when the flag is off", () => {
    isHeroVerdictEnabledMock.mockReturnValue(false);

    const { container } = render(
      <HeroMobileIdentity coin={BASE_COIN} {...COMMON_PROPS} reportCard={INSTITUTIONAL_REPORT_CARD} />,
    );

    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("HeroDesktopIdentity verdict pill", () => {
  beforeEach(() => {
    isHeroVerdictEnabledMock.mockReset();
  });
  afterEach(cleanup);

  it("renders the pill and wires aria-describedby when the flag is on and the archetype is categorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(
      <HeroDesktopIdentity coin={BASE_COIN} {...COMMON_PROPS} reportCard={INSTITUTIONAL_REPORT_CARD} />,
    );

    const verdictId = `hero-verdict-${BASE_COIN.id}`;
    const pill = container.querySelector(`#${verdictId}`);
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-archetype")).toBe("institutional-default");
    expect(pill?.textContent).toBe("Institutional Default");

    const heading = container.querySelector("h2");
    expect(heading?.getAttribute("aria-describedby")).toBe(verdictId);
  });

  it("hides the pill and omits aria-describedby when the archetype is uncategorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const uncategorizedCoin: StablecoinMeta = { ...BASE_COIN, mechanismArchetype: undefined };
    const { container } = render(<HeroDesktopIdentity coin={uncategorizedCoin} {...COMMON_PROPS} />);

    expect(container.querySelector(`#hero-verdict-${uncategorizedCoin.id}`)).toBeNull();
    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("hides the pill and omits aria-describedby when the flag is off", () => {
    isHeroVerdictEnabledMock.mockReturnValue(false);

    const { container } = render(
      <HeroDesktopIdentity coin={BASE_COIN} {...COMMON_PROPS} reportCard={INSTITUTIONAL_REPORT_CARD} />,
    );

    expect(container.querySelector(`#hero-verdict-${BASE_COIN.id}`)).toBeNull();
    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });
});
