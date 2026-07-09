// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { createRef, type ImgHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCard, makeStablecoin } from "@/test/fixtures/safety-scores";
import type { ReportCard, StablecoinData, StablecoinMeta } from "@shared/types";

const { isMobileStickySummaryEnabledMock } = vi.hoisted(() => ({
  isMobileStickySummaryEnabledMock: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isMobileStickySummaryEnabled: isMobileStickySummaryEnabledMock,
}));

vi.mock("next/image", () => ({
  default: ({ alt, ...props }: ImgHTMLAttributes<HTMLImageElement>) => <img alt={alt} {...props} />,
}));

import { MobileStickySummary } from "../mobile-sticky-summary";

const COIN: StablecoinMeta = {
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

const COIN_DATA: StablecoinData = makeStablecoin({
  id: "usdc-circle",
  name: "USD Coin",
  symbol: "USDC",
  priceSource: "coingecko",
  supplySource: "defillama",
  circulating: { peggedUSD: 1_000_000_000 },
  circulatingPrevDay: { peggedUSD: 995_000_000 },
  circulatingPrevWeek: { peggedUSD: 980_000_000 },
  circulatingPrevMonth: { peggedUSD: 970_000_000 },
  chains: ["ethereum"],
});

const REPORT_CARD: ReportCard = makeReportCard({
  id: "usdc-circle",
  name: "USD Coin",
  symbol: "USDC",
  overallGrade: "B+",
  overallScore: 79,
  baseScore: 79,
  dimensions: {
    pegStability: { grade: "A", score: 95, detail: "" },
    liquidity: { grade: "B+", score: 82, detail: "" },
    resilience: { grade: "B", score: 70, detail: "" },
    decentralization: { grade: "C", score: 55, detail: "" },
    dependencyRisk: { grade: "B", score: 73, detail: "" },
  },
  ratedDimensions: 5,
  rawInputs: {
    pegScore: 95,
    activeDepeg: false,
    activeDepegBps: null,
    depegEventCount: 0,
    lastEventAt: null,
    liquidityScore: 82,
    effectiveExitScore: 82,
    redemptionBackstopScore: null,
    redemptionRouteFamily: null,
    redemptionModelConfidence: null,
    redemptionUsedForLiquidity: false,
    redemptionImmediateCapacityUsd: null,
    redemptionImmediateCapacityRatio: null,
    concentrationHhi: 0.2,
    bluechipGrade: null,
    canBeBlacklisted: true,
    chainTier: "ethereum",
    deploymentModel: "native-multichain",
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
    governanceTier: "centralized",
    governanceQuality: "regulated-entity",
    dependencies: [],
    navToken: false,
    collateralFromLive: false,
    dependencyFromLive: false,
  },
  isDefunct: false,
});

type IOTrigger = (isIntersecting: boolean) => void;

function makeObserverHook() {
  let trigger: IOTrigger | null = null;
  const observe = vi.fn();
  const disconnect = vi.fn();
  class FakeIntersectionObserver {
    private callback: IntersectionObserverCallback;
    constructor(cb: IntersectionObserverCallback) {
      this.callback = cb;
      trigger = (isIntersecting: boolean) => {
        this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      };
    }
    observe(target: Element) {
      observe(target);
    }
    disconnect() {
      disconnect();
    }
    unobserve() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = "";
    thresholds = [];
  }
  class FakeResizeObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return {
    fireIntersecting: (val: boolean) => {
      if (trigger) trigger(val);
    },
    observe,
    disconnect,
  };
}

describe("MobileStickySummary", () => {
  beforeEach(() => {
    isMobileStickySummaryEnabledMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty("--pharos-sticky-summary-h");
  });

  it("returns null when the feature flag is off", () => {
    isMobileStickySummaryEnabledMock.mockReturnValue(false);
    makeObserverHook();
    const targetRef = createRef<HTMLElement>();
    const { container } = render(
      <>
        <section ref={targetRef as React.RefObject<HTMLElement>} />
        <MobileStickySummary
          coin={COIN}
          coinData={COIN_DATA}
          pegRef={1}
          logoSrc="/logos/usdc.svg"
          reportCard={REPORT_CARD}
          observeTarget={targetRef}
        />
      </>,
    );
    // The <section> renders; the sticky summary does not.
    expect(container.querySelector("[class*='sticky']")).toBeNull();
  });

  it("returns null while the observe target is in view (no IO fire yet)", () => {
    isMobileStickySummaryEnabledMock.mockReturnValue(true);
    makeObserverHook();
    const targetRef = createRef<HTMLElement>();
    const { container } = render(
      <>
        <section ref={targetRef as React.RefObject<HTMLElement>} />
        <MobileStickySummary
          coin={COIN}
          coinData={COIN_DATA}
          pegRef={1}
          logoSrc="/logos/usdc.svg"
          reportCard={REPORT_CARD}
          observeTarget={targetRef}
        />
      </>,
    );
    // Default visible=false on mount; the sticky DOM should be absent.
    expect(container.querySelector("[class*='sticky']")).toBeNull();
  });

  it("renders the summary and publishes --pharos-sticky-summary-h once the target leaves the viewport", () => {
    isMobileStickySummaryEnabledMock.mockReturnValue(true);
    const io = makeObserverHook();
    const targetRef = createRef<HTMLElement>();
    const { container } = render(
      <>
        <section ref={targetRef as React.RefObject<HTMLElement>} />
        <MobileStickySummary
          coin={COIN}
          coinData={COIN_DATA}
          pegRef={1}
          logoSrc="/logos/usdc.svg"
          reportCard={REPORT_CARD}
          observeTarget={targetRef}
        />
      </>,
    );

    expect(io.observe).toHaveBeenCalled();

    act(() => {
      io.fireIntersecting(false);
    });

    const sticky = container.querySelector("[class*='sticky']");
    expect(sticky).not.toBeNull();
    expect(sticky?.textContent).toContain("USDC");
    // The CSS var is set on document.documentElement after mount.
    const heightVar = document.documentElement.style.getPropertyValue("--pharos-sticky-summary-h");
    expect(heightVar).toMatch(/px$/);
  });
});
