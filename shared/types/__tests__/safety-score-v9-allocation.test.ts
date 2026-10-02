import { describe, expect, it } from "vitest";
import {
  SafetyScoreV9WrapperAllocationReviewSchema,
  V9ScopedAllocationClaimSchema,
  allocationReviewClockSec,
  type V9ScopedAllocationClaim,
} from "../safety-score-v9-allocation";

function claim(): V9ScopedAllocationClaim {
  const deployment = { codeKind: "proxy" as const, chain: "arbitrum", address: "0x1111111111111111111111111111111111111111", implementation: "0x2222222222222222222222222222222222222222", block: 100, observedAtSec: 1790848800, sourceUrl: "https://example.com/code" };
  return {
    claimKey: "contract-borrowing", dimension: "leverage", layer: "contract",
    target: { kind: "deployment", deployment, reachableTargets: [deployment], reachableSetComplete: true },
    coverage: { kind: "scope-only", shareFraction: null }, disposition: "reviewed", statement: "no-borrowing-surface",
    rationale: "Exact local callable code has no borrowing surface, not an entity leverage claim.",
    reviewedAt: "2026-10-01T10:01:00Z", observedAtSec: 1790848800, expiresAtSec: 1793527200,
    sources: [{ label: "Exact verified source", url: "https://example.com/code" }],
    observations: [{ sourceUrl: "https://example.com/code", observedAtSec: 1790848800, description: "Proxy slot and reachable code at block 100" }],
  };
}

describe("allocation scope schema", () => {
  it("admits isolated contract facts without inventing custody or reuse and cannot parse them as whole-allocation", () => {
    const scoped = { scopeKind: "per-dimension", assetId: "mixed", reviewer: "fixture", rationale: "Isolated fact", claims: [claim()] };
    expect(SafetyScoreV9WrapperAllocationReviewSchema.parse(scoped).scopeKind).toBe("per-dimension");
    expect(SafetyScoreV9WrapperAllocationReviewSchema.safeParse({ ...scoped, scopeKind: "whole-allocation" }).success).toBe(false);
    expect(SafetyScoreV9WrapperAllocationReviewSchema.safeParse({ ...scoped, custody: "fully-onchain-no-offchain-custodian", localLeverage: "no-borrowing-surface", capitalReuse: "none" }).success).toBe(false);
  });
  it("requires an implementation and the exact root in the complete reachable target set", () => {
    const row = claim();
    if (row.target.kind !== "deployment") throw new Error("Expected deployment");
    expect(V9ScopedAllocationClaimSchema.safeParse({ ...row, target: { ...row.target, deployment: { ...row.target.deployment, implementation: undefined } } }).success).toBe(false);
    row.target.reachableTargets[0] = { ...row.target.reachableTargets[0]!, address: "0x3333333333333333333333333333333333333333" };
    expect(V9ScopedAllocationClaimSchema.safeParse(row).success).toBe(false);
  });
  it("keeps conditional legal allocation null and forbids whole-book assertions from conditional legs", () => {
    const row = { ...claim(), dimension: "providerIdentity", layer: "immediate-custodian", statement: "provider-identified", target: { kind: "reserve-leg", sourceKey: null, providerOrEntity: "Wilmington Trust", applicability: "conditional", conditions: "Where an executed series escrow appoints this provider" }, coverage: { kind: "conditional", condition: "Escrow is used", shareFraction: null } };
    expect(V9ScopedAllocationClaimSchema.parse(row).coverage.shareFraction).toBeNull();
    expect(V9ScopedAllocationClaimSchema.safeParse({ ...row, coverage: { kind: "whole-dimension", denominator: "accepted-reserve-envelope", reserveSourceKeys: ["reserve:loan"], shareFraction: 1 } }).success).toBe(false);
  });
  it("rejects invented denominators, overlapping rosters, duplicate claim ids and source-unbound observations", () => {
    const row = claim();
    expect(V9ScopedAllocationClaimSchema.safeParse({ ...row, coverage: { kind: "whole-dimension", denominator: "wallet-count", reserveSourceKeys: ["leg"], shareFraction: 1 } }).success).toBe(false);
    expect(V9ScopedAllocationClaimSchema.safeParse({ ...row, coverage: { kind: "whole-dimension", denominator: "accepted-reserve-envelope", reserveSourceKeys: ["leg", "leg"], shareFraction: 1 } }).success).toBe(false);
    expect(SafetyScoreV9WrapperAllocationReviewSchema.safeParse({ scopeKind: "per-dimension", assetId: "mixed", reviewer: "fixture", rationale: "Facts", claims: [row, row] }).success).toBe(false);
    expect(V9ScopedAllocationClaimSchema.safeParse({ ...row, observations: [{ ...row.observations[0], sourceUrl: "https://other.example.com" }] }).success).toBe(false);
  });
  it("requires review after observation and expiry after both, with date-only admission after the UTC day", () => {
    const row = claim();
    expect(V9ScopedAllocationClaimSchema.safeParse({ ...row, reviewedAt: "2026-10-01T09:00:00Z" }).success).toBe(false);
    expect(V9ScopedAllocationClaimSchema.safeParse({ ...row, expiresAtSec: row.observedAtSec }).success).toBe(false);
    expect(allocationReviewClockSec("2026-10-01")).toBe(Date.parse("2026-10-02T00:00:00Z") / 1000);
  });
  it("does not turn code assurance into legal supervision or a contract no-borrowing statement into holder rights", () => {
    expect(V9ScopedAllocationClaimSchema.safeParse({ ...claim(), dimension: "holderClaim" }).success).toBe(false);
    expect(V9ScopedAllocationClaimSchema.safeParse({ ...claim(), dimension: "supervision", statement: "provider-identified" }).success).toBe(false);
  });
});
