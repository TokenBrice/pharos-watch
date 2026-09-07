import { describe, expect, it, vi } from "vitest";
import { blockAnalyticsCollection } from "../maintenance/audit-seo-render-budget.mjs";

describe("render-budget analytics suppression", () => {
  it("aborts collectors and counts them while leaving analytics scripts and site data unhandled", async () => {
    let matcher!: (url: URL) => boolean;
    let handler!: (route: { abort: () => Promise<void> }) => Promise<void>;
    const page = {
      route: vi.fn(async (pattern: typeof matcher, callback: typeof handler) => {
        matcher = pattern;
        handler = callback;
      }),
    };
    const counters = { blockedAnalyticsRequests: 0 };
    const abort = vi.fn(async () => {});
    await blockAnalyticsCollection(page, counters);

    for (const url of [
      "https://www.google-analytics.com/g/collect?v=2",
      "https://region1.google-analytics.com/g/collect?v=2",
      "https://analytics.google.com/g/collect?v=2",
      "https://www.google.com/g/collect?v=2",
      "https://www.google-analytics.com/collect?v=1",
    ]) {
      expect(matcher(new URL(url))).toBe(true);
      await handler({ abort });
    }
    expect(abort).toHaveBeenCalledTimes(5);
    expect(counters.blockedAnalyticsRequests).toBe(5);

    for (const url of [
      "https://www.googletagmanager.com/gtag/js?id=G-TEST",
      "https://www.googletagmanager.com/gtm.js?id=GTM-TEST",
      "https://www.google-analytics.com/analytics.js",
      "https://pharos.watch/_site-data/stablecoins",
      "https://pharos.watch/collect",
      "https://google-analytics.com.example.org/g/collect?v=2",
    ]) {
      expect(matcher(new URL(url))).toBe(false);
    }
  });
});
