import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllTrackingTimers, isAnalyticsAllowed, trackEvent, trackSearch } from "@/lib/analytics";

describe("trackSearch debounce + clearAllTrackingTimers", () => {
  let gtag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    gtag = vi.fn();
    (globalThis as { window?: unknown }).window = {
      gtag,
      location: { pathname: "/", hostname: "pharos.watch" },
    };
  });

  afterEach(() => {
    clearAllTrackingTimers();
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });

  it("fires search_performed once after the debounce window elapses", () => {
    trackSearch("depeg", 4);
    expect(gtag).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith("event", "search_performed", {
      page: "depeg",
      query_length: 4,
    });
  });

  it("does not fire the previous page's event after clearAllTrackingTimers (navigation)", () => {
    trackSearch("depeg", 4);
    // user navigates away mid-debounce
    clearAllTrackingTimers();
    vi.advanceTimersByTime(1000);
    expect(gtag).not.toHaveBeenCalled();
  });

  it("suppresses custom events in the embedded Telegram Mini App", () => {
    (globalThis as { window: { location: { pathname: string } } }).window.location.pathname =
      "/pharoswatchbot/app/";

    trackEvent("theme_toggled", { theme: "dark" });

    expect(gtag).not.toHaveBeenCalled();
  });
});

describe("public analytics scope", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["pharos.watch", "localhost", "127.0.0.1", "[::1]"])(
    "allows public routes on %s, including explicit loopback smoke checks",
    (hostname) => {
      for (const path of ["/", "/yield/", "/pharoswatchbot/", "/portfolio/"]) {
        expect(isAnalyticsAllowed(path, hostname)).toBe(true);
      }
    },
  );

  it.each(["", "ops.pharos.watch", "stablecoin-dashboard.pages.dev", "preview.stablecoin-dashboard.pages.dev", "www.pharos.watch", "pharos.watch.example.com"])(
    "excludes %s even on a public route",
    (hostname) => {
      expect(isAnalyticsAllowed("/", hostname)).toBe(false);
    },
  );

  it.each([null, "", "/admin", "/admin/", "/admin/crons/", "/admin-api", "/admin-api/keys/", "/pharoswatchbot/app", "/pharoswatchbot/app/settings/"])(
    "excludes unavailable or nonpublic path %s",
    (path) => {
      expect(isAnalyticsAllowed(path, "pharos.watch")).toBe(false);
      expect(isAnalyticsAllowed(path, "localhost")).toBe(false);
    },
  );

  it.each([
    ["pharos.watch", "/", true],
    ["pharos.watch", "/admin/crons/", false],
    ["pharos.watch", "/pharoswatchbot/app/", false],
    ["ops.pharos.watch", "/", false],
    ["stablecoin-dashboard.pages.dev", "/", false],
  ] as const)("gates custom events at invocation on %s%s", (hostname, pathname, allowed) => {
    const gtag = vi.fn();
    vi.stubGlobal("window", { location: { hostname, pathname }, gtag });
    trackEvent("comparison_created", { coin_count: 2, coin_ids: "usdt-tether,usdc-circle" });
    expect(gtag).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
});
