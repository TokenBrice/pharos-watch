import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllTrackingTimers, isAnalyticsAllowed, trackEvent, trackSearch } from "@/lib/analytics";
import type * as Analytics from "@/lib/analytics";
import type { Mock } from "vitest";

describe("trackSearch debounce + clearAllTrackingTimers", () => {
  let gtag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    gtag = vi.fn();
    vi.stubGlobal("window", {
      gtag,
      location: { pathname: "/", hostname: "pharos.watch" },
    });
  });

  afterEach(() => {
    clearAllTrackingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not fire the previous page's event after clearAllTrackingTimers (navigation)", () => {
    trackSearch("depeg", 4);
    // user navigates away mid-debounce
    clearAllTrackingTimers();
    vi.advanceTimersByTime(1000);
    expect(gtag).not.toHaveBeenCalled();
  });

  it("rechecks route privacy when a pending search is delivered", () => {
    trackSearch("depeg", 4);
    vi.advanceTimersByTime(500);
    window.location.pathname = "/admin/";
    vi.advanceTimersByTime(500);
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

describe("fresh data readiness telemetry", () => {
  let analytics: typeof Analytics;
  let clock: number;
  let gtag: Mock;

  beforeEach(async () => {
    vi.resetModules();
    // Fresh module state is the boundary under test: no prior navigation may leak between cases.
    analytics = await import("@/lib/analytics");
    clock = 1250;
    gtag = vi.fn();
    vi.stubGlobal("performance", { now: () => clock, timeOrigin: 100_000 });
    vi.stubGlobal("window", { gtag, location: { hostname: "pharos.watch", pathname: "/" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records document navigation to live readiness once despite StrictMode or polling", () => {
    analytics.trackFreshDataReady("home-hero");
    clock = 1500;
    analytics.trackFreshDataReady("home-hero");
    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith("event", "fresh_data_ready", {
      surface: "home-hero", value: 1250, page_path: "/",
      id: "100000:0:home-hero", navigation_type: "navigate",
    });
  });

  it("restarts the readiness clock and dedupe scope on router-observed navigation", () => {
    analytics.beginAnalyticsNavigation("/");
    window.location.pathname = "/stablecoin/usdt-tether/";
    analytics.beginAnalyticsNavigation(window.location.pathname);
    clock = 1600;
    analytics.trackFreshDataReady("detail-summary");
    expect(gtag).toHaveBeenLastCalledWith("event", "fresh_data_ready", expect.objectContaining({
      value: 350, navigation_type: "route-change", surface: "detail-summary",
    }));
  });

  it("does not mark readiness sent when analytics is unavailable", () => {
    const allowed = window.gtag;
    window.gtag = undefined;
    analytics.trackFreshDataReady("home-hero");
    window.gtag = allowed;
    analytics.trackFreshDataReady("home-hero");
    expect(gtag).toHaveBeenCalledTimes(1);
  });

  it.each(["ops.pharos.watch", "preview.stablecoin-dashboard.pages.dev"])("respects origin gating on %s", (hostname) => {
    window.location.hostname = hostname;
    analytics.trackFreshDataReady("home-hero");
    expect(gtag).not.toHaveBeenCalled();
  });

  it.each(["/admin/", "/pharoswatchbot/app/", "/privacy/"])("never reports readiness on %s", (pathname) => {
    window.location.pathname = pathname;
    analytics.trackFreshDataReady("home-hero");
    analytics.trackFreshDataReady("detail-summary");
    expect(gtag).not.toHaveBeenCalled();
  });
});
