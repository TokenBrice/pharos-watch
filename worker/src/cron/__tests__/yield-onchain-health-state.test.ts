import { describe, it, expect } from "vitest";
import { buildNextDeterministicOnChainHealthState } from "../yield-sync/state-loading";
import {
  getDefaultDeterministicOnChainHealthState,
  type DeterministicOnChainHealthState,
} from "../yield-sync/cache";

// Mirrors the module-private constants in state-loading.ts.
const COOLDOWN_THRESHOLD = 2;
const COOLDOWN_SEC = 6 * 3600;
const START = 1_000_000;

const DEFAULT = getDefaultDeterministicOnChainHealthState();

type Params = Parameters<typeof buildNextDeterministicOnChainHealthState>[0];

function baseParams(overrides: Partial<Params> = {}): Params {
  return {
    deterministicConfigCount: 4,
    previous: DEFAULT,
    startSec: START,
    onChainAttemptedCount: 4,
    onChainRatesResolved: 0,
    allDeterministicFailed: false,
    maskedAllDeterministicFailure: false,
    onChainAlternativeCoverageMissingIds: [],
    onChainSkippedDueToCooldown: false,
    ...overrides,
  };
}

function previousWith(overrides: Partial<DeterministicOnChainHealthState>): DeterministicOnChainHealthState {
  return { ...DEFAULT, ...overrides };
}

describe("buildNextDeterministicOnChainHealthState", () => {
  it("resets to default when there are no deterministic configs", () => {
    const result = buildNextDeterministicOnChainHealthState(
      baseParams({
        deterministicConfigCount: 0,
        previous: previousWith({ consecutiveAllFailRuns: 3, cooldownUntil: START + COOLDOWN_SEC }),
      }),
    );
    expect(result).toEqual(DEFAULT);
  });

  describe("skipped due to cooldown", () => {
    it("preserves prior state and stamps lastSkippedAt when alternative coverage is complete", () => {
      const previous = previousWith({
        consecutiveAllFailRuns: 2,
        consecutiveMaskedAllFailRuns: 2,
        cooldownUntil: START + COOLDOWN_SEC,
        lastSuccessAt: 500,
      });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({ previous, onChainSkippedDueToCooldown: true }),
      );
      expect(result).toEqual({ ...previous, lastSkippedAt: START });
    });

    it("resets accumulators but records the missing ids when alternative coverage has gaps", () => {
      const previous = previousWith({ consecutiveAllFailRuns: 2, consecutiveMaskedAllFailRuns: 2 });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({
          previous,
          onChainSkippedDueToCooldown: true,
          onChainAlternativeCoverageMissingIds: ["aave-usdc", "morpho-usdt"],
        }),
      );
      expect(result).toEqual({
        ...DEFAULT,
        lastSkippedAt: START,
        lastFailureMissingIds: ["aave-usdc", "morpho-usdt"],
      });
    });
  });

  describe("nothing attempted", () => {
    it("keeps an active future cooldown", () => {
      const previous = previousWith({
        consecutiveAllFailRuns: 2,
        consecutiveMaskedAllFailRuns: 2,
        cooldownUntil: START + 100,
      });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({ previous, onChainAttemptedCount: 0 }),
      );
      expect(result).toEqual({ ...previous, cooldownUntil: START + 100 });
    });

    it("clears an expired cooldown", () => {
      const previous = previousWith({ cooldownUntil: START - 100 });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({ previous, onChainAttemptedCount: 0 }),
      );
      expect(result).toEqual({ ...previous, cooldownUntil: null });
    });
  });

  it("resets to a fresh success state when any on-chain rate resolves", () => {
    const previous = previousWith({ consecutiveAllFailRuns: 5, consecutiveMaskedAllFailRuns: 5 });
    const result = buildNextDeterministicOnChainHealthState(
      baseParams({ previous, onChainRatesResolved: 3, allDeterministicFailed: true }),
    );
    expect(result).toEqual({
      ...DEFAULT,
      lastAttemptedAt: START,
      lastSuccessAt: START,
    });
  });

  describe("all deterministic sources failed", () => {
    it("increments unmasked all-fail runs but never triggers cooldown and resets the masked counter", () => {
      const previous = previousWith({ consecutiveAllFailRuns: 1, consecutiveMaskedAllFailRuns: 5, lastSuccessAt: 42 });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({
          previous,
          allDeterministicFailed: true,
          maskedAllDeterministicFailure: false,
          onChainAlternativeCoverageMissingIds: ["x"],
        }),
      );
      expect(result.consecutiveAllFailRuns).toBe(2);
      expect(result.consecutiveMaskedAllFailRuns).toBe(0);
      expect(result.cooldownUntil).toBeNull();
      expect(result.lastAttemptedAt).toBe(START);
      expect(result.lastAllFailedAt).toBe(START);
      expect(result.lastSuccessAt).toBe(42);
      expect(result.lastFailureMissingIds).toEqual(["x"]);
    });

    it("accumulates masked all-fail runs below the threshold without cooldown", () => {
      const previous = previousWith({ consecutiveAllFailRuns: 0, consecutiveMaskedAllFailRuns: COOLDOWN_THRESHOLD - 2 });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({ previous, allDeterministicFailed: true, maskedAllDeterministicFailure: true }),
      );
      expect(result.consecutiveMaskedAllFailRuns).toBe(COOLDOWN_THRESHOLD - 1);
      expect(result.cooldownUntil).toBeNull();
    });

    it("triggers cooldown once masked all-fail runs reach the threshold", () => {
      const previous = previousWith({ consecutiveAllFailRuns: 1, consecutiveMaskedAllFailRuns: COOLDOWN_THRESHOLD - 1 });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({ previous, allDeterministicFailed: true, maskedAllDeterministicFailure: true }),
      );
      expect(result.consecutiveMaskedAllFailRuns).toBe(COOLDOWN_THRESHOLD);
      expect(result.cooldownUntil).toBe(START + COOLDOWN_SEC);
    });
  });

  it("records the attempt and resets accumulators for a partial (non-total) failure", () => {
    const previous = previousWith({ consecutiveAllFailRuns: 4, consecutiveMaskedAllFailRuns: 4 });
    const result = buildNextDeterministicOnChainHealthState(
      baseParams({ previous, allDeterministicFailed: false, onChainRatesResolved: 0 }),
    );
    expect(result).toEqual({ ...DEFAULT, lastAttemptedAt: START });
  });
});
