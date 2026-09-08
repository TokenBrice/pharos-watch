import { describe, expect, it } from "vitest";
import {
  DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
  DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
  DDR_FORECAST_READINESS_VERSION,
} from "../../methodology-versions/depeg-resolver";
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
  });

  it("pins duration-support branches that can suppress early readiness", () => {
    const terminal = forecastReadinessScore(readyInput({
      resolution: {
        tier: "recovery_unlikely",
        factors: [
          {
            code: "K5_exit_collapse",
            kind: "kill",
            severity: "severe",
            label: "Exit collapsed",
          },
        ],
      },
      duration: {
        ...readyInput().duration,
        suppressed: true,
        suppressedReason: "verdict_terminal",
        medianSec: null,
        iqrSec: null,
        horizons: [],
      },
    }));
    expect(terminal.components.find((component) => component.key === "duration_support")).toMatchObject({
      score: 0.9,
    });

    const genericSuppressed = forecastReadinessScore(readyInput({
      duration: {
        ...readyInput().duration,
        suppressed: true,
        suppressedReason: "insufficient_support",
        medianSec: null,
        iqrSec: null,
        horizons: [],
      },
    }));
    expect(genericSuppressed.components.find((component) => component.key === "duration_support")).toMatchObject({
      score: 0.35,
    });

    const noHorizons = forecastReadinessScore(readyInput({
      duration: {
        ...readyInput().duration,
        horizons: [],
      },
    }));
    expect(noHorizons.components.find((component) => component.key === "duration_support")).toMatchObject({
      score: 0.25,
    });
  });

  it("pins observation maturity before the floor, on the ramp, and at the backstop", () => {
    const early = forecastReadinessScore(readyInput({ ageSec: 30 * 60 }));
    expect(early.components.find((component) => component.key === "observation_maturity")).toMatchObject({
      score: 0,
    });

    const ramp = forecastReadinessScore(readyInput({ ageSec: 3.5 * 3600 }));
    expect(ramp.components.find((component) => component.key === "observation_maturity")).toMatchObject({
      score: 0.5,
    });

    const backstop = forecastReadinessScore(readyInput({ ageSec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC }));
    expect(backstop.components.find((component) => component.key === "observation_maturity")).toMatchObject({
      score: 1,
    });
  });

  it("degrades mixed horizon support and independently missing estimate bounds", () => {
    const duration = readyInput().duration;
    const support = (overrides: Partial<typeof duration>) =>
      forecastReadinessScore(readyInput({ duration: { ...duration, ...overrides } }))
        .components.find((component) => component.key === "duration_support")?.score;
    expect(support({})).toBe(1);
    expect(support({
      horizons: [benchmarkedHorizon, { ...benchmarkedHorizon, horizon: "7d", state: "unsupported" }],
    })).toBe(0.681);
    expect(support({ medianSec: null })).toBe(0.888);
    expect(support({ iqrSec: null })).toBe(0.888);
  });
});

describe("forecast readiness lock helpers", () => {
  it("does not reach the backstop without a clock or one second before it", () => {
    const startedAt = 100;
    expect(buildForecastReadinessBackstop({ startedAt }).reached).toBe(false);
    expect(buildForecastReadinessBackstop({ startedAt, nowSec: null }).reached).toBe(false);
    expect(buildForecastReadinessBackstop({
      startedAt, nowSec: startedAt + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC - 1,
    }).reached).toBe(false);
  });

  it("prioritizes the reached backstop even when strict early readiness is satisfied", () => {
    expect(forecastReadinessLockTrigger({
      readiness: { score: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD + 0.001 },
      backstop: buildForecastReadinessBackstop({
        startedAt: 100, nowSec: 100 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
      }),
    })).toBe("readiness_backstop");
  });

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
