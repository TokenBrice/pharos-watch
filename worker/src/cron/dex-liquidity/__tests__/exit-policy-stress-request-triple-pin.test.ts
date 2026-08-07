import { describe, expect, it } from "vitest";
import policy from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  DEFAULT_NOTIONALS_USD,
  IMMEDIATE_SETTLEMENT_HORIZON_SEC,
  REFERENCE_COST_BPS,
} from "@shared/lib/p4-exit-route-capacity";
import { V9_DEX_STRESS_MAX_COST_BPS, V9_DEX_STRESS_NOTIONAL_USD } from "../scoring";

const exitPolicy = (policy as { semantic: { exit: Record<string, unknown> } }).semantic.exit;
const stressRequest = exitPolicy.stressRequest as {
  notionalGridUsd: number[];
  maxCostBps: number;
  settlementHorizonSec: number;
  capUsd: number;
};

// Drift tripwire: the stress-request triple (notional grid, max cost, and
// settlement horizon) is independently authored in three places — the
// methodology policy JSON, the shared P4 exit-route-capacity defaults, and
// the worker's V9 DEX stress-scoring constants. This test pins all three
// against each other; a failure means real drift already exists between the
// copies and must be reconciled by hand, not by editing this test.
describe("exit stress-request triple stays pinned across policy, p4, and DEX worker constants", () => {
  it("notional grid matches the P4 default notional ladder", () => {
    expect(stressRequest.notionalGridUsd).toEqual([...DEFAULT_NOTIONALS_USD]);
  });

  it("max cost bps matches across policy, P4, and the DEX worker stress constant", () => {
    expect(stressRequest.maxCostBps).toBe(REFERENCE_COST_BPS);
    expect(stressRequest.maxCostBps).toBe(V9_DEX_STRESS_MAX_COST_BPS);
  });

  it("settlement horizon matches the P4 immediate-settlement horizon", () => {
    expect(stressRequest.settlementHorizonSec).toBe(IMMEDIATE_SETTLEMENT_HORIZON_SEC);
  });

  it("stress cap matches the DEX worker's stress notional ($25M)", () => {
    expect(stressRequest.capUsd).toBe(V9_DEX_STRESS_NOTIONAL_USD);
    expect(V9_DEX_STRESS_NOTIONAL_USD).toBe(25_000_000);
    expect(V9_DEX_STRESS_MAX_COST_BPS).toBe(200);
  });
});
