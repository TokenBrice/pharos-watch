// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAnalytics } from "@/components/google-analytics";

const { pathnameMock } = vi.hoisted(() => ({
  pathnameMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: pathnameMock,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  delete window.dataLayer;
  delete window.gtag;
  pathnameMock.mockReset();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("GoogleAnalytics", () => {
  it.each(["/admin/", "/admin/crons/", "/admin-api/"])("does not bootstrap analytics on %s", (path) => {
    pathnameMock.mockReturnValue(path);
    render(<GoogleAnalytics measurementId="G-TEST" />);
    expect(window.gtag).toBeUndefined();
    expect(window.dataLayer).toBeUndefined();
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
  });

  it.each(["ops.pharos.watch", "stablecoin-dashboard.pages.dev", "preview.stablecoin-dashboard.pages.dev"])(
    "does not bootstrap analytics on %s",
    (hostname) => {
      pathnameMock.mockReturnValue("/");
      vi.spyOn(window, "location", "get").mockReturnValue({ hostname } as Location);
      render(<GoogleAnalytics measurementId="G-TEST" />);
      expect(window.gtag).toBeUndefined();
      expect(window.dataLayer).toBeUndefined();
      expect(document.getElementById("pharos-google-analytics")).toBeNull();
    },
  );

  it("does not bootstrap Google Analytics in the embedded Telegram Mini App", async () => {
    pathnameMock.mockReturnValue("/pharoswatchbot/app/");

    render(<GoogleAnalytics measurementId="G-TEST" />);

    act(() => vi.runAllTimers());
    expect(window.gtag).toBeUndefined();
    expect(window.dataLayer).toBeUndefined();
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
  });

  it("keeps analytics enabled on the public PharosWatchBot page", async () => {
    pathnameMock.mockReturnValue("/pharoswatchbot/");

    render(<GoogleAnalytics measurementId="G-TEST" />);

    expect(window.dataLayer).toHaveLength(4);
    expect(Array.from(window.dataLayer?.at(-1) ?? [])).toEqual([
      "event",
      "page_view",
      expect.objectContaining({ page_path: "/pharoswatchbot/" }),
    ]);
  });

  it("queues native gtag arguments objects so gtag.js can emit collect hits", async () => {
    pathnameMock.mockReturnValue("/");

    render(<GoogleAnalytics measurementId="G-TEST" />);

    expect(window.dataLayer).toHaveLength(4);

    const entries = window.dataLayer ?? [];
    expect(entries.every((entry) => !Array.isArray(entry))).toBe(true);
    expect(Array.from(entries[0] ?? [])).toEqual([
      "consent",
      "default",
      {
        ad_storage: "denied",
        analytics_storage: "granted",
        ad_user_data: "denied",
        ad_personalization: "denied",
      },
    ]);
    expect(Array.from(entries[2] ?? [])).toEqual(["config", "G-TEST", { send_page_view: false }]);
    expect(Array.from(entries[3] ?? [])).toEqual([
      "event",
      "page_view",
      expect.objectContaining({ page_path: "/" }),
    ]);
    // The gtag.js download is deferred to an idle window (requestIdleCallback,
    // or a setTimeout fallback in jsdom) so its execution stays off the load
    // critical path; the injected script still carries the measurement id.
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(document.getElementById("pharos-google-analytics")).toHaveProperty(
      "src", "https://www.googletagmanager.com/gtag/js?id=G-TEST",
    );
  });

  it("scrubs query-string verification tokens before page_view tracking", async () => {
    pathnameMock.mockReturnValue("/api/");
    window.history.replaceState(null, "", "/api/?verify=legacy-secret&utm_source=email");

    render(<GoogleAnalytics measurementId="G-TEST" />);

    expect(window.dataLayer).toHaveLength(4);
    const pageViewEntry = Array.from(window.dataLayer?.at(3) ?? []);
    expect(window.location.search).toBe("?utm_source=email");
    expect(pageViewEntry).toEqual([
      "event",
      "page_view",
      expect.objectContaining({
        page_path: "/api/?utm_source=email",
        page_location: "http://localhost:3000/api/?utm_source=email",
      }),
    ]);
  });

  it("tracks SPA path changes after bootstrap", async () => {
    pathnameMock.mockReturnValue("/");
    const view = render(<GoogleAnalytics measurementId="G-TEST" />);

    expect(window.dataLayer).toHaveLength(4);
    pathnameMock.mockReturnValue("/liquidity/");
    view.rerender(<GoogleAnalytics measurementId="G-TEST" />);

    expect(window.dataLayer).toHaveLength(5);
    const lastEntry = Array.from(window.dataLayer?.at(-1) ?? []);
    expect(lastEntry).toEqual([
      "event",
      "page_view",
      expect.objectContaining({ page_path: "/liquidity/" }),
    ]);
  });
  it.each(["unmount", "private-route"])("cancels pending script injection on %s", (transition) => {
    pathnameMock.mockReturnValue("/");
    const view = render(<GoogleAnalytics measurementId="G-TEST" />);
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
    if (transition === "unmount") view.unmount();
    else {
      pathnameMock.mockReturnValue("/admin/");
      view.rerender(<GoogleAnalytics measurementId="G-TEST" />);
    }
    act(() => vi.runAllTimers());
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
  });

});
