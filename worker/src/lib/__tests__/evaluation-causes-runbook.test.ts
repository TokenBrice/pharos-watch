import { describe, it, expect } from "vitest";
import { RUNBOOK_BY_CODE, withRunbook } from "../status/evaluation-causes";
import type { StatusCause } from "@shared/types/status";

describe("StatusCause.runbookUrl", () => {
  it("populates runbookUrl for known codes", () => {
    const cause: StatusCause = {
      code: "db_unhealthy",
      layer: "availability",
      severity: "critical",
      message: "DB unhealthy",
    };
    expect(withRunbook(cause).runbookUrl).toBe("/docs/runbooks/db-connectivity");
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
    expect(withUrl.runbookUrl).toBe("/docs/runbooks/stablecoins-cache");
  });

  it("covers all codes listed in RUNBOOK_BY_CODE with valid documented URLs", () => {
    const expectedPrefix = "/docs/runbooks/";
    for (const [code, url] of Object.entries(RUNBOOK_BY_CODE)) {
      expect(code, `code must be non-empty`).toBeTruthy();
      expect(url.startsWith(expectedPrefix), `url for ${code} must start with ${expectedPrefix}`).toBe(true);
    }
    // Sanity: at least 5 documented runbooks so the feature is meaningful.
    expect(Object.keys(RUNBOOK_BY_CODE).length).toBeGreaterThanOrEqual(5);
  });
});
