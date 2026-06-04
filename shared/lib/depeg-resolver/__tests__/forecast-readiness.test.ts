import { describe, expect, it } from "vitest";
import {
  DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
  DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
  DDR_FORECAST_READINESS_VERSION,
} from "../../depeg-resolver-version";
import type { DdrForecastReadinessInput } from "../forecast-readiness";
import {
  buildForecastReadinessBackstop,
  forecastReadinessLockTrigger,
  forecastReadinessScore,
  meetsStrictEarlyLockReadiness,
} from "../forecast-readiness";

const benchmarkedHorizon = {
  horizon: "24h" as const,
  state: "benchmarked" as const,
  probability: 0.75,
  probabilityDisplay: "75%",
  probabilityInterval: { lower: 0.65, upper: 0.85 },
  rawAtRisk: 12,
  uniqueCoins: 12,
  intervalClosures: 9,
  intervalNonClosures: 3,
};

function readyInput(overrides: Partial<DdrForecastReadinessInput> = {}): DdrForecastReadinessInput {
  return {
    ageSec: 6 * 3600,
    currentDeviationBps: -150,
    resolution: {
      tier: "recovery_likely",
      factors: [
        {
          code: "R1_noninflatable_supply",
          kind: "anchor",
          severity: "strong",
          label: "Immutable supply",
        },
      ],
    },
    duration: {
      suppressed: false,
      suppressedReason: null,
      stratum: "below - moderate - robust - USD",
      medianSec: 12 * 3600,
      iqrSec: [6 * 3600, 24 * 3600],
      ageStatus: "ordinary",
      horizons: [benchmarkedHorizon],
    },
    ...overrides,
  };
}

describe("forecastReadinessScore", () => {
  it("returns bounded forecast-readiness metadata with reasons and components", () => {
    const readiness = forecastReadinessScore(readyInput());

    expect(readiness.version).toBe(DDR_FORECAST_READINESS_VERSION);
    expect(readiness.threshold).toBe(DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD);
    expect(readiness.score).toBeGreaterThanOrEqual(0);
    expect(readiness.score).toBeLessThanOrEqual(1);
    expect(readiness.strictEarlyLockReady).toBe(true);
    expect(readiness.reasons.length).toBe(readiness.components.length);
    expect(readiness.components.map((component) => component.key)).toEqual([
      "input_coverage",
      "resolution_signal",
      "duration_support",
      "observation_maturity",
    ]);
  });

  it("uses a strict greater-than threshold for early locks", () => {
    expect(meetsStrictEarlyLockReadiness({ score: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD })).toBe(false);
    expect(meetsStrictEarlyLockReadiness({ score: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD + 0.001 })).toBe(true);
  });

  it("keeps insufficient-signal rows below strict early-lock readiness", () => {
    const readiness = forecastReadinessScore(readyInput({
      currentDeviationBps: null,
      resolution: {
        tier: "insufficient_signal",
        factors: [],
        insufficientReasons: ["No reviewed mint authority", "No usable supply history for this coin"],
      },
      duration: {
        suppressed: true,
        suppressedReason: "insufficient_signal",
        stratum: null,
        medianSec: null,
        iqrSec: null,
        ageStatus: null,
        horizons: [],
      },
    }));

    expect(readiness.score).toBeLessThanOrEqual(DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD);
    expect(readiness.strictEarlyLockReady).toBe(false);
    expect(readiness.reasons.join(" ")).toContain("Missing forecast-readiness inputs");
  });
});

describe("forecast readiness lock helpers", () => {
  it("builds the 72h backstop and separates strict readiness from backstop locking", () => {
    const backstop = buildForecastReadinessBackstop({
      startedAt: 100,
      nowSec: 100 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
    });

    expect(backstop).toEqual({
      version: DDR_FORECAST_READINESS_VERSION,
      delaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
      backstopAt: 100 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
      reached: true,
    });
    expect(forecastReadinessLockTrigger({
      readiness: { score: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD },
      backstop,
    })).toBe("readiness_backstop");
    expect(forecastReadinessLockTrigger({
      readiness: { score: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD + 0.001 },
      backstop: { reached: false },
    })).toBe("forecast_readiness");
    expect(forecastReadinessLockTrigger({
      readiness: { score: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD },
      backstop: { reached: false },
    })).toBe("scheduled_24h");
  });
});
