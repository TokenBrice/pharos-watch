import { describe, expect, it } from "vitest";
import {
  classifyV9MissingDataWorkType,
  classifyV9ScoreProjectionWorkType,
  type V9MissingDataWorkType,
} from "../maintenance/generate-safety-score-v9-missing-data-registry";

function classify(reasonCode: string, componentKey = "fixture"): V9MissingDataWorkType {
  return classifyV9MissingDataWorkType({
    reasonCode,
    path: { kind: "local-component", componentKey },
  } as Parameters<typeof classifyV9MissingDataWorkType>[0]);
}

describe("Safety Score v9 missing-data work routing", () => {
  it.each([
    ["missing-pillar-evidence", "chain-supply", "CHAIN_SUPPLY"],
    ["missing-access-review", "access:freeze", "ACCESS_REVIEW"],
    ["missing-archetype", "mechanism-risk-review", "ARCHETYPE_CLASSIFICATION"],
    ["bounded-mechanism-review", "mechanism-review:backstop", "MECHANISM_REVIEW"],
    ["missing-reserve-composition", "reserve-composition", "RESERVE_COMPOSITION"],
    ["material-reserve-slice-unstructured", "fixture", "RESERVE_SLICE"],
    ["missing-runtime-route-evidence", "exit-routes", "EXIT_RUNTIME_ROUTE"],
    ["incomplete-dex-route-coverage", "exit-portfolio-coverage", "EXIT_DEX_COVERAGE"],
    ["unresolved-exit-output", "fixture", "EXIT_OUTPUT"],
    ["missing-mint-authority", "economic-control:mint", "MINT_AUTHORITY"],
    ["unresolved-control-identity", "deployment-controls", "DEPLOYMENT_CONTROLS"],
    ["missing-upgradeability-review", "deployment-controls", "DEPLOYMENT_CONTROLS"],
    ["missing-oracle-profile", "economic-control:oracle", "ORACLE_PROFILE"],
    ["incomplete-oracle-liquidation-branch", "economic-control:oracle:feed", "ORACLE_BRANCH"],
    ["missing-bridge-routes", "economic-control:bridge", "BRIDGE_ROUTE_REVIEW"],
    ["runtime-bridge-materiality-unavailable", "bridge-materiality", "BRIDGE_MATERIALITY"],
    ["missing-peg-input", "peg", "PEG_INPUT"],
    ["unreviewed-dependency-relationships", "effective-dependencies", "DEPENDENCY_REVIEW"],
    ["missing-implementation-date", "implementation-date", "IMPLEMENTATION_DATE"],
  ] as const)("routes %s at %s to %s", (reasonCode, componentKey, expected) => {
    expect(classify(reasonCode, componentKey)).toBe(expected);
  });

  it("fails closed when a new reason has no agent work definition", () => {
    expect(() => classify("unregistered-reason")).toThrow(/Missing agent work-type definition/);
  });

  it.each([
    ["unknown-upgrade-authority", "DEPLOYMENT_CONTROLS"],
    ["selected-bridge-route-unresolved", "BRIDGE_ROUTE_REVIEW"],
    ["missing-same-notional-route", "EXIT_RUNTIME_ROUTE"],
    ["unsupported-same-notional-route", "EXIT_DEX_COVERAGE"],
    ["unresolved-mint-authority", "MINT_AUTHORITY"],
  ] as const)("routes score-only reason %s to %s", (reasonCode, expected) => {
    expect(classifyV9ScoreProjectionWorkType(reasonCode)).toBe(expected);
  });

  it("does not turn known structural risk into a missing-data task", () => {
    expect(classifyV9ScoreProjectionWorkType("correlated-exit-routes")).toBeNull();
  });
});
