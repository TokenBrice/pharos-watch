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

});
