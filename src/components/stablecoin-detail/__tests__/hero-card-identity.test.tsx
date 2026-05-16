// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";

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

import { HeroDesktopIdentity, HeroMobileIdentity } from "../hero-card-identity";

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
};

const ONE_LINER = "Regulated USD-backed stablecoin from Circle.";

const COMMON_PROPS = {
  infrastructures: [],
  reportCard: null,
  variantParent: null,
  variantChipClass: null,
  logoSrc: undefined,
} as const;

describe("HeroMobileIdentity verdict line", () => {
  beforeEach(() => {
    isHeroVerdictEnabledMock.mockReset();
  });
  afterEach(cleanup);

  it("renders the verdict and wires aria-describedby when the flag is on and oneLiner is present", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);
    const coin = { ...BASE_COIN, oneLiner: ONE_LINER };

    const { container } = render(<HeroMobileIdentity coin={coin} {...COMMON_PROPS} />);

    const verdictId = `hero-verdict-${coin.id}`;
    const verdictEl = container.querySelector(`#${verdictId}`);
    expect(verdictEl).not.toBeNull();
    expect(verdictEl?.tagName).toBe("P");
    expect(verdictEl?.textContent).toBe(ONE_LINER);

    const heading = container.querySelector("h2");
    expect(heading?.getAttribute("aria-describedby")).toBe(verdictId);
  });

  it("hides the verdict and omits aria-describedby when the flag is on but oneLiner is absent", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(<HeroMobileIdentity coin={BASE_COIN} {...COMMON_PROPS} />);

    expect(container.querySelector(`#hero-verdict-${BASE_COIN.id}`)).toBeNull();
    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("hides the verdict and omits aria-describedby when the flag is off even if oneLiner is present", () => {
    isHeroVerdictEnabledMock.mockReturnValue(false);
    const coin = { ...BASE_COIN, oneLiner: ONE_LINER };

    const { container } = render(<HeroMobileIdentity coin={coin} {...COMMON_PROPS} />);

    expect(container.querySelector(`#hero-verdict-${coin.id}`)).toBeNull();
    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("HeroDesktopIdentity verdict line", () => {
  beforeEach(() => {
    isHeroVerdictEnabledMock.mockReset();
  });
  afterEach(cleanup);

  it("renders the verdict and wires aria-describedby when the flag is on and oneLiner is present", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);
    const coin = { ...BASE_COIN, oneLiner: ONE_LINER };

    const { container } = render(<HeroDesktopIdentity coin={coin} {...COMMON_PROPS} />);

    const verdictId = `hero-verdict-${coin.id}`;
    const verdictEl = container.querySelector(`#${verdictId}`);
    expect(verdictEl).not.toBeNull();
    expect(verdictEl?.tagName).toBe("P");
    expect(verdictEl?.textContent).toBe(ONE_LINER);

    const heading = container.querySelector("h2");
    expect(heading?.getAttribute("aria-describedby")).toBe(verdictId);
  });

  it("hides the verdict and omits aria-describedby when the flag is on but oneLiner is absent", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(<HeroDesktopIdentity coin={BASE_COIN} {...COMMON_PROPS} />);

    expect(container.querySelector(`#hero-verdict-${BASE_COIN.id}`)).toBeNull();
    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("hides the verdict and omits aria-describedby when the flag is off even if oneLiner is present", () => {
    isHeroVerdictEnabledMock.mockReturnValue(false);
    const coin = { ...BASE_COIN, oneLiner: ONE_LINER };

    const { container } = render(<HeroDesktopIdentity coin={coin} {...COMMON_PROPS} />);

    expect(container.querySelector(`#hero-verdict-${coin.id}`)).toBeNull();
    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });
});
