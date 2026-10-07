import { describe, it, expect } from "vitest";
import { withRunbook } from "../status/evaluation-rules";
import type { StatusCause } from "@shared/types/status";

describe("StatusCause.runbookUrl", () => {
  it("populates runbookUrl for known codes", () => {
    const cause: StatusCause = {
      code: "db_unhealthy",
      layer: "availability",
      severity: "critical",
      message: "DB unhealthy",
    };
    expect(withRunbook(cause).runbookUrl).toBe("https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/db-connectivity.md");
  });

  it.each([
    "price_gap_reviews_expiring",
    "price_gap_reviews_expired",
    "price_gap_reviews_invalid",
    "reserve_feed_reviews_expiring",
    "reserve_feed_reviews_expired",
    "reserve_feed_reviews_invalid",
  ])("routes %s to the review renewal procedure", (code) => {
    const cause: StatusCause = { code, layer: "data-quality", severity: "info", message: "Review needs attention." };
    expect(withRunbook(cause).runbookUrl).toBe("https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/review-renewal.md");
  });

  it("omits runbookUrl for codes without a documented runbook", () => {
    const cause: StatusCause = {
      code: "unknown_code_that_has_no_runbook",
      layer: "availability",
      severity: "critical",
      message: "—",
    };
    expect(withRunbook(cause).runbookUrl).toBeUndefined();
  });

  it("preserves all original cause fields when adding runbookUrl", () => {
    const cause: StatusCause = {
      code: "stablecoins_cache_degraded",
      layer: "availability",
      severity: "warning",
      message: "Cache is 5 min old",
      metric: "cache_age",
      value: 300,
      threshold: 60,
    };
    const withUrl = withRunbook(cause);
    expect(withUrl).toMatchObject(cause);
    expect(withUrl.runbookUrl).toBe("https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/stablecoins-cache.md");
  });

});
