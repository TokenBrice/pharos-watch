// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "pipeline", label: "Pipeline" },
  { id: "reliability", label: "Reliability" },
];

const SECTION_DOCUMENT_TOPS: Record<string, number> = {
  overview: 100,
  pipeline: 500,
  reliability: 1_800,
};

function rect({
  top = 0,
  left = 0,
  width = 100,
  height = 48,
}: {
  top?: number;
  left?: number;
  width?: number;
  height?: number;
} = {}): DOMRect {
  return {
    width,
    height,
    top,
    right: left + width,
    bottom: top + height,
    left,
    x: left,
    y: top,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

function Harness({
  sections = SECTIONS,
  stickyOffsetPx,
}: {
  sections?: Array<{ id: string; label: string }>;
  stickyOffsetPx?: number;
}) {
  return (
    <div>
      <LongformScrollspyNav sections={sections} navAriaLabel="Status sections" stickyOffsetPx={stickyOffsetPx} />
      <section id="overview">Overview content</section>
      <section id="pipeline">Pipeline content</section>
      <section id="reliability">Reliability content</section>
    </div>
  );
}

describe("LongformScrollspyNav", () => {
  const windowScrollToMock = vi.fn();
  const elementScrollToMock = vi.fn();
  const scrollIntoViewMock = vi.fn();

  function setScrollY(value: number) {
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value,
      writable: true,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: windowScrollToMock,
      writable: true,
    });
    Object.defineProperty(window, "scrollX", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 2_000,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: elementScrollToMock,
      writable: true,
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
      writable: true,
    });
    setScrollY(0);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id in SECTION_DOCUMENT_TOPS) {
        return rect({
          top: SECTION_DOCUMENT_TOPS[this.id] - window.scrollY,
          height: 300,
        });
      }
      if (this.matches("nav")) return rect({ width: 200 });
      if (this.matches('a[href="#pipeline"]')) return rect({ left: 280, width: 80 });
      if (this.matches("a")) return rect({ left: 20, width: 80 });
      if (this.classList.contains("sticky")) return rect({ height: 48 });
      return rect();
    });
    window.history.replaceState(null, "", window.location.pathname);
    windowScrollToMock.mockClear();
    elementScrollToMock.mockClear();
    scrollIntoViewMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.replaceState(null, "", window.location.pathname);
  });

  it("uses the first section at document top even when later headings cross the activation line", () => {
    render(<Harness stickyOffsetPx={1_000} />);

    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("link", { name: "Pipeline" }).getAttribute("aria-current")).toBeNull();
  });

  it("selects the last heading above the stable activation line mid-document", () => {
    setScrollY(600);
    render(<Harness stickyOffsetPx={106} />);

    expect(screen.getByRole("link", { name: "Pipeline" }).getAttribute("aria-current")).toBe("true");
  });

  it("uses the final section at the document scroll maximum", () => {
    render(<Harness stickyOffsetPx={106} />);

    setScrollY(1_500);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });

    expect(screen.getByRole("link", { name: "Reliability" }).getAttribute("aria-current")).toBe("true");
  });

  it("aligns an initial hash from the explicit sticky offset only once", () => {
    window.history.replaceState(null, "", "#pipeline");

    const { rerender } = render(<Harness stickyOffsetPx={106} />);

    act(() => {
      vi.runAllTimers();
    });

    expect(windowScrollToMock).toHaveBeenCalledTimes(4);
    expect(windowScrollToMock).toHaveBeenNthCalledWith(1, { top: 330, behavior: "auto" });
    expect(document.getElementById("pipeline")?.style.scrollMarginTop).toBe(
      "calc(170px + var(--pharos-sticky-summary-h, 0px))",
    );

    rerender(<Harness sections={[SECTIONS[1], SECTIONS[0], SECTIONS[2]]} stickyOffsetPx={106} />);

    act(() => {
      vi.runAllTimers();
    });

    expect(windowScrollToMock).toHaveBeenCalledTimes(4);
  });

  it("does not start hash alignment on a later refresh when the page loaded without one", () => {
    const { rerender } = render(<Harness stickyOffsetPx={106} />);

    act(() => {
      vi.runAllTimers();
    });

    expect(windowScrollToMock).not.toHaveBeenCalled();

    window.history.replaceState(null, "", "#pipeline");
    rerender(<Harness sections={[SECTIONS[1], SECTIONS[0], SECTIONS[2]]} stickyOffsetPx={106} />);

    act(() => {
      vi.runAllTimers();
    });

    expect(windowScrollToMock).not.toHaveBeenCalled();
  });

  it("centers the active pill inside the nav scroller without moving document scrollX", () => {
    render(<Harness stickyOffsetPx={106} />);
    const scroller = screen.getByRole("navigation", { name: "Status sections" });
    const scrollerScrollToMock = vi.fn();
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 600 },
      scrollLeft: { configurable: true, value: 0, writable: true },
      scrollTo: { configurable: true, value: scrollerScrollToMock },
    });
    Object.defineProperty(window, "scrollX", {
      configurable: true,
      value: 47,
      writable: true,
    });

    fireEvent.click(screen.getByRole("link", { name: "Pipeline" }));

    expect(scrollerScrollToMock).toHaveBeenCalledWith({ left: 220, behavior: "auto" });
    expect(window.scrollX).toBe(47);
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("keeps default responsive offsets and supports an explicit sticky top override", () => {
    const { container, rerender } = render(<Harness />);

    const stickyNav = container.querySelector<HTMLElement>(".sticky");
    expect(stickyNav?.className).toContain("top-[calc(env(safe-area-inset-top)+3.5rem)]");
    expect(stickyNav?.className).toContain("lg:top-[calc(env(safe-area-inset-top)+3px)]");
    expect(stickyNav?.style.top).toBe("");

    rerender(<Harness stickyOffsetPx={106} />);
    expect(stickyNav?.style.top).toBe("106px");
  });
});
