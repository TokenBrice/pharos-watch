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
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
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
    // Browsers without idle callbacks wait five seconds after the paint fallback.
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
    act(() => vi.advanceTimersByTime(5_031));
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(document.getElementById("pharos-google-analytics")).toHaveProperty(
      "src", "https://www.googletagmanager.com/gtag/js?id=G-TEST",
    );
  });

  it.each(["loading", "interactive"] as const)("queues events while %s and schedules idle only after load", (readyState) => {
    vi.spyOn(document, "readyState", "get").mockReturnValue(readyState);
    const idle = vi.fn(() => 1);
    vi.stubGlobal("requestIdleCallback", idle);
    pathnameMock.mockReturnValue("/");
    render(<GoogleAnalytics measurementId="G-TEST" />);

    window.gtag?.("event", "fresh_data_ready", { page: "home" });
    expect(Array.from(window.dataLayer?.at(-1) ?? [])).toEqual([
      "event", "fresh_data_ready", { page: "home" },
    ]);
    act(() => vi.advanceTimersByTime(10_000));
    expect(idle).not.toHaveBeenCalled();
    expect(document.getElementById("pharos-google-analytics")).toBeNull();

    act(() => window.dispatchEvent(new Event("load")));
    expect(idle).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 5_000 });
    act(() => window.dispatchEvent(new Event("load")));
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("schedules immediately after load and cancels the idle callback on unmount", () => {
    const idle = vi.fn(() => 7);
    const cancelIdle = vi.fn();
    vi.stubGlobal("requestIdleCallback", idle);
    vi.stubGlobal("cancelIdleCallback", cancelIdle);
    pathnameMock.mockReturnValue("/");
    const view = render(<GoogleAnalytics measurementId="G-TEST" />);
    expect(idle).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 5_000 });
    view.unmount();
    expect(cancelIdle).toHaveBeenCalledWith(7);
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

  it.each([
    ["complete", "unmount"], ["complete", "private-route"],
    ["loading", "unmount"], ["loading", "private-route"],
  ] as const)("cancels pending script injection from %s on %s", (readyState, transition) => {
    vi.spyOn(document, "readyState", "get").mockReturnValue(readyState);
    pathnameMock.mockReturnValue("/");
    const view = render(<GoogleAnalytics measurementId="G-TEST" />);
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
    if (transition === "unmount") view.unmount();
    else {
      pathnameMock.mockReturnValue("/admin/");
      view.rerender(<GoogleAnalytics measurementId="G-TEST" />);
    }
    act(() => {
      window.dispatchEvent(new Event("load"));
      vi.runAllTimers();
    });
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
  });

});
