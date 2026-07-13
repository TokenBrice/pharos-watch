import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import { buildBridgeRouteCoverageAudit } from "../lib/bridge-route-coverage-audit";

describe("bridge-route coverage audit", () => {
  it("requires exact deployment rows for every active multi-deployment asset", () => {
    const audit = buildBridgeRouteCoverageAudit(ACTIVE_STABLECOINS, "2026-07-13T00:00:00.000Z");
    expect(audit.summary).toMatchObject({
      applicableMultiDeploymentCoins: 218,
      reviewedProfiles: 218,
      completeRouteProfiles: 218,
      missingProfiles: 0,
      incompleteRouteProfiles: 0,
    });
    expect(audit.summary.routes).toBeGreaterThan(800);
  });
});
