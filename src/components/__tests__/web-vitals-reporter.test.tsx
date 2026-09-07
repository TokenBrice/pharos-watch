// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { pathnameMock, reportCallbacks } = vi.hoisted(() => ({
  pathnameMock: vi.fn(),
  reportCallbacks: [] as Array<(metric: unknown) => void>,
}));

vi.mock("next/navigation", () => ({
  usePathname: pathnameMock,
}));

vi.mock("next/web-vitals", () => ({
  useReportWebVitals: (cb: (metric: unknown) => void) => {
    reportCallbacks.push(cb);
  },
}));

import { WebVitalsReporter } from "@/components/web-vitals-reporter";

afterEach(() => {
  delete window.gtag;
  delete window.dataLayer;
  pathnameMock.mockReset();
  reportCallbacks.length = 0;
  window.history.replaceState(null, "", "/");
});

describe("WebVitalsReporter", () => {
  it("keeps one callback identity while reading the latest public pathname", () => {
    pathnameMock.mockReturnValue("/");
    window.gtag = vi.fn();
    const view = render(<WebVitalsReporter />);
    const callback = reportCallbacks[0];
    window.history.replaceState(null, "", "/liquidity/");
    pathnameMock.mockReturnValue("/liquidity/");
    view.rerender(<WebVitalsReporter />);
    expect(reportCallbacks[1]).toBe(callback);
    callback({ name: "INP", value: 80, id: "same-document" });
    expect(window.gtag).toHaveBeenCalledWith("event", "web_vital", expect.objectContaining({
      page_path: "/liquidity/", id: "same-document",
    }));
  });

  it("blocks a previously registered callback after navigating from a public page to ops", () => {
    pathnameMock.mockReturnValue("/");
    window.gtag = vi.fn();
    const view = render(<WebVitalsReporter />);
    const callback = reportCallbacks[0];

    window.history.replaceState(null, "", "/admin/crons/");
    callback({ name: "LCP", value: 1234, id: "before-router-update" });
    pathnameMock.mockReturnValue("/admin/crons/");
    view.rerender(<WebVitalsReporter />);
    expect(reportCallbacks[1]).toBe(callback);
    callback({ name: "LCP", value: 1234, id: "after-router-update" });

    expect(window.gtag).not.toHaveBeenCalled();
  });

  it("does not send Web Vitals from the embedded Telegram Mini App", () => {
    pathnameMock.mockReturnValue("/pharoswatchbot/app/");
    const gtag = vi.fn();
    window.gtag = gtag;

    render(<WebVitalsReporter />);
    reportCallbacks[0]({ name: "LCP", value: 1234.5, id: "v4-mini-app" });

    expect(gtag).not.toHaveBeenCalled();
  });

  it("forwards a web vital metric to window.gtag via trackEvent with page_path attached", () => {
    pathnameMock.mockReturnValue("/stablecoin/usdc/");
    const gtag = vi.fn();
    window.gtag = gtag;

    render(<WebVitalsReporter />);

    expect(reportCallbacks).toHaveLength(1);
    reportCallbacks[0]({
      name: "LCP",
      value: 1234.5,
      id: "v4-1700000000000-1234567890123",
      rating: "good",
      navigationType: "navigate",
    });

    expect(gtag).toHaveBeenCalledWith("event", "web_vital", {
      name: "LCP",
      value: 1234.5,
      id: "v4-1700000000000-1234567890123",
      rating: "good",
      navigation_type: "navigate",
      page_path: "/stablecoin/usdc/",
    });
  });

  it("defaults rating and navigation_type when the metric omits them", () => {
    pathnameMock.mockReturnValue("/");
    const gtag = vi.fn();
    window.gtag = gtag;

    render(<WebVitalsReporter />);
    reportCallbacks[0]({ name: "CLS", value: 0.05, id: "v4-x" });

    expect(gtag).toHaveBeenCalledWith(
      "event",
      "web_vital",
      expect.objectContaining({
        name: "CLS",
        value: 0.05,
        id: "v4-x",
        rating: "good",
        navigation_type: "navigate",
        page_path: "/",
      }),
    );
  });

  it("renders nothing (no DOM output)", () => {
    pathnameMock.mockReturnValue("/");
    const { container } = render(<WebVitalsReporter />);
    expect(container.textContent).toBe("");
  });
});
