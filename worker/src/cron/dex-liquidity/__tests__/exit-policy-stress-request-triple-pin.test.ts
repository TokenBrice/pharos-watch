import { describe, expect, it } from "vitest";
import { EXIT_ROUTE_SCORING_TABLES } from "@shared/lib/exit-route-scoring";
import {
  DEFAULT_NOTIONALS_USD,
  IMMEDIATE_SETTLEMENT_HORIZON_SEC,
  REFERENCE_COST_BPS,
} from "@shared/lib/p4-exit-route-capacity";
import { V9_DEX_STRESS_MAX_COST_BPS, V9_DEX_STRESS_NOTIONAL_USD } from "../scoring";

/**
 * Copy-matches-source, not copy-matches-copy.
 *
 * The stress-request triple (notional grid, max cost, settlement horizon) used
 * to be authored independently in three places, and this file could only report
 * that drift had *already* happened. The P4 exit-route defaults and the worker's
 * V9 DEX stress constants now derive from `EXIT_ROUTE_SCORING_TABLES.request`,
 * so this asserts that each named view still points at the field it claims to.
 *
 * The policy JSON's `semantic.exit.stressRequest` is validated against the same
 * source by `shared/lib/__tests__/exit-policy-constants-pin.test.ts`; it is not
 * re-pinned here.
 */
describe("exit stress-request views derive from the single exit-scoring source", () => {
  const request = EXIT_ROUTE_SCORING_TABLES.request;

  it("exposes the source notional ladder as the P4 default notionals", () => {
    expect(DEFAULT_NOTIONALS_USD).toBe(request.notionalGridUsd);
  });

  it("exposes the source max cost as both the P4 reference cost and the DEX stress cost", () => {
    expect(REFERENCE_COST_BPS).toBe(request.maxCostBps);
    expect(V9_DEX_STRESS_MAX_COST_BPS).toBe(request.maxCostBps);
  });

  it("exposes the source settlement horizon as the P4 immediate-settlement horizon", () => {
    expect(IMMEDIATE_SETTLEMENT_HORIZON_SEC).toBe(request.settlementHorizonSec);
  });

  it("exposes the source stress cap as the DEX stress notional", () => {
    expect(V9_DEX_STRESS_NOTIONAL_USD).toBe(request.capUsd);
  });
});
