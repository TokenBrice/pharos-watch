// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
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
  cleanup();
  delete window.gtag;
  delete window.dataLayer;
  pathnameMock.mockReset();
  reportCallbacks.length = 0;
});

describe("WebVitalsReporter", () => {
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
