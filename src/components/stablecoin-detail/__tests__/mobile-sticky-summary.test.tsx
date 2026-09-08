// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { createRef, type ImgHTMLAttributes, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import type { StablecoinData, StablecoinMeta } from "@shared/types";

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

const REPORT_CARD = makeV9Card({
  id: "usdc-circle",
  grade: "B+",
  score: 79,
});

const HEIGHT_VAR = "--pharos-sticky-summary-h";

type IOTrigger = (isIntersecting: boolean) => void;

/**
 * Layout is supplied explicitly: jsdom measures every element as zero, so a
 * broken measurement (or a hard-coded constant) would otherwise satisfy any
 * published-height assertion.
 */
function makeObserverHook(initialHeight: number) {
  let ioTrigger: IOTrigger | null = null;
  let roTrigger: (() => void) | null = null;
  let height = initialHeight;
  const ioObserve = vi.fn();
  const ioDisconnect = vi.fn();
  const roObserve = vi.fn();
  const roDisconnect = vi.fn();

  class FakeIntersectionObserver {
    constructor(private callback: IntersectionObserverCallback) {
      ioTrigger = (isIntersecting: boolean) => {
        this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      };
    }
    observe(target: Element) {
      ioObserve(target);
    }
    disconnect() {
      ioDisconnect();
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
    constructor(private callback: ResizeObserverCallback) {
      roTrigger = () => {
        this.callback([], this as unknown as ResizeObserver);
      };
    }
    observe(target: Element) {
      roObserve(target);
    }
    disconnect() {
      roDisconnect();
    }
    unobserve() {}
  }

  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ height, width: 390, top: 0, left: 0, right: 390, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );

  return {
    ioObserve,
    ioDisconnect,
    roObserve,
    roDisconnect,
    resizeTo(next: number) {
      height = next;
      act(() => {
        roTrigger?.();
      });
    },
    fireIntersecting(isIntersecting: boolean) {
      act(() => {
        ioTrigger?.(isIntersecting);
      });
    },
  };
}

function Summary({ targetRef }: { targetRef: RefObject<HTMLElement | null> }) {
  return (
    <>
      <section ref={targetRef as RefObject<HTMLElement>} />
      <MobileStickySummary
        coin={COIN}
        coinData={COIN_DATA}
        pegRef={1}
        logoSrc="/logos/usdc.svg"
        reportCard={REPORT_CARD}
        observeTarget={targetRef}
      />
    </>
  );
}

function renderSummary() {
  const targetRef = createRef<HTMLElement>();
  const view = render(<Summary targetRef={targetRef} />);
  return {
    unmount: view.unmount,
    rerender: () => view.rerender(<Summary targetRef={targetRef} />),
    sticky: () => view.container.querySelector("[class*='sticky']"),
    publishedHeight: () => document.documentElement.style.getPropertyValue(HEIGHT_VAR),
  };
}

describe("MobileStickySummary", () => {
  beforeEach(() => {
    isMobileStickySummaryEnabledMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty(HEIGHT_VAR);
  });

  it("returns null when the feature flag is off", () => {
    isMobileStickySummaryEnabledMock.mockReturnValue(false);
    const io = makeObserverHook(57.6);
    const view = renderSummary();

    expect(view.sticky()).toBeNull();
    expect(io.ioObserve).not.toHaveBeenCalled();
  });

  it("returns null while the observe target is in view (no IO fire yet)", () => {
    isMobileStickySummaryEnabledMock.mockReturnValue(true);
    makeObserverHook(57.6);
    const view = renderSummary();

    expect(view.sticky()).toBeNull();
    expect(view.publishedHeight()).toBe("");
  });

  it("publishes its rounded measured height once the target leaves the viewport, and republishes it on resize", () => {
    isMobileStickySummaryEnabledMock.mockReturnValue(true);
    const io = makeObserverHook(57.6);
    const view = renderSummary();

    expect(io.ioObserve).toHaveBeenCalledTimes(1);
    io.fireIntersecting(false);

    const sticky = view.sticky();
    expect(sticky).not.toBeNull();
    expect(sticky?.textContent).toContain("USDC");
    expect(view.publishedHeight()).toBe("58px");
    expect(io.roObserve).toHaveBeenCalledWith(sticky);

    io.resizeTo(40.2);
    expect(view.publishedHeight()).toBe("40px");
  });

  it("hides the summary and drops the published height when the target scrolls back into view", () => {
    isMobileStickySummaryEnabledMock.mockReturnValue(true);
    const io = makeObserverHook(57.6);
    const view = renderSummary();

    io.fireIntersecting(false);
    expect(view.publishedHeight()).toBe("58px");

    io.fireIntersecting(true);

    expect(view.sticky()).toBeNull();
    expect(view.publishedHeight()).toBe("");
    expect(io.roDisconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects both observers and drops the published height on unmount while visible", () => {
    isMobileStickySummaryEnabledMock.mockReturnValue(true);
    const io = makeObserverHook(57.6);
    const view = renderSummary();

    io.fireIntersecting(false);
    expect(view.publishedHeight()).toBe("58px");

    view.unmount();

    expect(io.ioDisconnect).toHaveBeenCalledTimes(1);
    expect(io.roDisconnect).toHaveBeenCalledTimes(1);
    expect(view.publishedHeight()).toBe("");
  });

  it("cleans up when the feature is disabled while the summary is visible", () => {
    isMobileStickySummaryEnabledMock.mockReturnValue(true);
    const io = makeObserverHook(57.6);
    const view = renderSummary();

    io.fireIntersecting(false);
    expect(view.publishedHeight()).toBe("58px");

    isMobileStickySummaryEnabledMock.mockReturnValue(false);
    act(() => {
      view.rerender();
    });

    expect(view.sticky()).toBeNull();
    expect(view.publishedHeight()).toBe("");
    expect(io.ioDisconnect).toHaveBeenCalledTimes(1);
    expect(io.roDisconnect).toHaveBeenCalledTimes(1);
  });
});
