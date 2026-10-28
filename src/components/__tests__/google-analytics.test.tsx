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

    expect(window.dataLayer).toHaveLength(6);

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
    expect(Array.from(entries[2] ?? [])).toEqual(["set", {
      page_location: "http://localhost:3000/",
      page_referrer: "",
    }]);
    expect(Array.from(entries[3] ?? [])).toEqual(["config", "G-TEST", { send_page_view: false }]);
    expect(Array.from(entries[5] ?? [])).toEqual([
      "event",
      "page_view",
      expect.objectContaining({ page_path: "/" }),
    ]);
    // Browsers without idle callbacks wait two seconds after the paint fallback.
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
    act(() => vi.advanceTimersByTime(2_031));
    expect(document.getElementById("pharos-google-analytics")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(document.getElementById("pharos-google-analytics")).toHaveProperty(
      "src", "https://www.googletagmanager.com/gtag/js?id=G-TEST",
    );
  });

  it.each(["loading", "interactive"] as const)("queues events while %s and schedules idle without waiting for load", (readyState) => {
    vi.spyOn(document, "readyState", "get").mockReturnValue(readyState);
    const idle = vi.fn(() => 1);
    vi.stubGlobal("requestIdleCallback", idle);
    pathnameMock.mockReturnValue("/");
    render(<GoogleAnalytics measurementId="G-TEST" />);

    window.gtag?.("event", "fresh_data_ready", { page: "home" });
    expect(Array.from(window.dataLayer?.at(-1) ?? [])).toEqual([
      "event", "fresh_data_ready", { page: "home" },
    ]);
    expect(idle).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 2_000 });
    expect(document.getElementById("pharos-google-analytics")).toBeNull();

    act(() => window.dispatchEvent(new Event("load")));
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("schedules immediately and cancels the idle callback on unmount", () => {
    const idle = vi.fn(() => 7);
    const cancelIdle = vi.fn();
    vi.stubGlobal("requestIdleCallback", idle);
    vi.stubGlobal("cancelIdleCallback", cancelIdle);
    pathnameMock.mockReturnValue("/");
    const view = render(<GoogleAnalytics measurementId="G-TEST" />);
    expect(idle).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 2_000 });
    view.unmount();
    expect(cancelIdle).toHaveBeenCalledWith(7);
  });

  it("injects the script only once when the effect runs again", () => {
    pathnameMock.mockReturnValue("/");
    const view = render(<GoogleAnalytics measurementId="G-TEST" />);
    act(() => vi.runAllTimers());
    pathnameMock.mockReturnValue("/admin/");
    view.rerender(<GoogleAnalytics measurementId="G-TEST" />);
    pathnameMock.mockReturnValue("/");
    view.rerender(<GoogleAnalytics measurementId="G-TEST" />);
    act(() => vi.runAllTimers());
    expect(document.querySelectorAll("#pharos-google-analytics")).toHaveLength(1);
  });

  it("scrubs query-string verification tokens before page_view tracking", async () => {
    pathnameMock.mockReturnValue("/api/");
    window.history.replaceState(null, "", "/api/?verify=legacy-secret&utm_source=email");

    render(<GoogleAnalytics measurementId="G-TEST" />);

    expect(window.dataLayer).toHaveLength(6);
    const pageViewEntry = Array.from(window.dataLayer?.at(5) ?? []);
    expect(window.location.search).toBe("?utm_source=email");
    expect(pageViewEntry).toEqual([
      "event",
      "page_view",
      expect.objectContaining({
        page_path: "/api/",
        page_location: "http://localhost:3000/api/",
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

  it("never sends query strings or fragments to gtag, including referrers", () => {
    pathnameMock.mockReturnValue("/portfolio/");
    window.history.replaceState(null, "", "/portfolio/?p=usdc-circle:123.45&verify=tok#holdings");
    vi.spyOn(document, "referrer", "get").mockReturnValue("https://example.com/a/b?secret=1#frag");

    const view = render(<GoogleAnalytics measurementId="G-TEST" />);
    pathnameMock.mockReturnValue("/stablecoins/");
    view.rerender(<GoogleAnalytics measurementId="G-TEST" />);

    const entries = Array.from(window.dataLayer ?? [], (entry) => Array.from(entry as ArrayLike<unknown>));
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/usdc-circle|123\.45|verify|tok|holdings|secret|frag|\?/);
    expect(window.location.search).toBe("?p=usdc-circle%3A123.45");
    const views = entries.filter((e) => e[0] === "event" && e[1] === "page_view");
    expect(views.map((e) => e[2])).toEqual([
      expect.objectContaining({
        page_path: "/portfolio/",
        page_location: "http://localhost:3000/portfolio/",
        page_referrer: "https://example.com/a/b",
      }),
      expect.objectContaining({
        page_path: "/stablecoins/",
        page_location: "http://localhost:3000/stablecoins/",
        page_referrer: "http://localhost:3000/portfolio/",
      }),
    ]);
  });

  it.each(["", "not a url", "android-app://com.google.android.gm/?q=1"])(
    "sends an empty referrer for %j",
    (referrer) => {
      pathnameMock.mockReturnValue("/");
      vi.spyOn(document, "referrer", "get").mockReturnValue(referrer);
      render(<GoogleAnalytics measurementId="G-TEST" />);
      const pageView = Array.from(window.dataLayer?.at(-1) ?? []);
      expect(pageView[2]).toEqual(expect.objectContaining({ page_referrer: "" }));
    },
  );
});
