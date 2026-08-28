// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Infrastructure, StablecoinMeta } from "@shared/types";

const { isHeroVerdictEnabledMock } = vi.hoisted(() => ({
  isHeroVerdictEnabledMock: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isHeroVerdictEnabled: isHeroVerdictEnabledMock,
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

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

const INSTITUTIONAL_VERDICT = {
  archetype: "institutional-default",
  label: "Institutional Default",
} as const;

const DISTRESSED_VERDICT = {
  archetype: "distressed",
  label: "Distressed",
} as const;

const UNCATEGORIZED_VERDICT = {
  archetype: "uncategorized",
  label: "Uncategorized",
} as const;

const COMMON_PROPS = {
  infrastructures: [] as Infrastructure[],
  verdict: INSTITUTIONAL_VERDICT,
  variantParent: null,
  variantChipClass: null,
  logoSrc: undefined,
} as const;

describe("HeroVerdict standalone (mobile section)", () => {
  beforeEach(() => {
    isHeroVerdictEnabledMock.mockReset();
  });

  it("renders the verdict pill when the flag is on and the archetype is categorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(<HeroVerdict coinId={BASE_COIN.id} verdict={INSTITUTIONAL_VERDICT} />);

    const verdictEl = container.querySelector(`#hero-verdict-${BASE_COIN.id}`);
    expect(verdictEl).not.toBeNull();
    expect(verdictEl?.getAttribute("data-archetype")).toBe("institutional-default");
    expect(verdictEl?.textContent).toBe("Institutional Default");
  });

  it("renders nothing when the archetype is uncategorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(<HeroVerdict coinId={BASE_COIN.id} verdict={UNCATEGORIZED_VERDICT} />);

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the flag is off", () => {
    isHeroVerdictEnabledMock.mockReturnValue(false);

    const { container } = render(<HeroVerdict coinId={BASE_COIN.id} verdict={INSTITUTIONAL_VERDICT} />);

    expect(container.firstChild).toBeNull();
  });
});

describe("HeroMobileIdentity heading aria-describedby", () => {
  beforeEach(() => {
    isHeroVerdictEnabledMock.mockReset();
  });

  it("wires aria-describedby when the flag is on and the archetype is categorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(<HeroMobileIdentity coin={BASE_COIN} {...COMMON_PROPS} />);

    const heading = container.querySelector("h2");
    expect(heading?.getAttribute("aria-describedby")).toBe(`hero-verdict-${BASE_COIN.id}`);
  });

  it("omits aria-describedby when the archetype is uncategorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(
      <HeroMobileIdentity coin={BASE_COIN} {...COMMON_PROPS} verdict={UNCATEGORIZED_VERDICT} />,
    );

    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("omits aria-describedby when the flag is off", () => {
    isHeroVerdictEnabledMock.mockReturnValue(false);

    const { container } = render(<HeroMobileIdentity coin={BASE_COIN} {...COMMON_PROPS} />);

    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("HeroDesktopIdentity verdict pill", () => {
  beforeEach(() => {
    isHeroVerdictEnabledMock.mockReset();
  });

  it("renders the pill and wires aria-describedby when the flag is on and the archetype is categorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(
      <HeroDesktopIdentity coin={BASE_COIN} {...COMMON_PROPS} verdict={DISTRESSED_VERDICT} />,
    );

    const verdictId = `hero-verdict-${BASE_COIN.id}`;
    const pill = container.querySelector(`#${verdictId}`);
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-archetype")).toBe("distressed");
    expect(pill?.textContent).toBe("Distressed");

    const heading = container.querySelector("h2");
    expect(heading?.getAttribute("aria-describedby")).toBe(verdictId);
  });

  it("hides the pill and omits aria-describedby when the archetype is uncategorized", () => {
    isHeroVerdictEnabledMock.mockReturnValue(true);

    const { container } = render(
      <HeroDesktopIdentity coin={BASE_COIN} {...COMMON_PROPS} verdict={UNCATEGORIZED_VERDICT} />,
    );

    expect(container.querySelector(`#hero-verdict-${BASE_COIN.id}`)).toBeNull();
    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("hides the pill and omits aria-describedby when the flag is off", () => {
    isHeroVerdictEnabledMock.mockReturnValue(false);

    const { container } = render(<HeroDesktopIdentity coin={BASE_COIN} {...COMMON_PROPS} />);

    expect(container.querySelector(`#hero-verdict-${BASE_COIN.id}`)).toBeNull();
    const heading = container.querySelector("h2");
    expect(heading?.hasAttribute("aria-describedby")).toBe(false);
  });
});
