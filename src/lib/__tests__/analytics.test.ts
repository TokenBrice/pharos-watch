import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllTrackingTimers, trackEvent, trackSearch } from "@/lib/analytics";

describe("trackSearch debounce + clearAllTrackingTimers", () => {
  let gtag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    gtag = vi.fn();
    (globalThis as { window?: unknown }).window = {
      gtag,
      location: { pathname: "/" },
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
