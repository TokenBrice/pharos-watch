import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDepegResolver } from "../depeg-resolver";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-resolver-version";
import { DDR_SNAPSHOT_CACHE_GENERATION } from "../../lib/depeg-resolver-snapshot-cache";
import type { DdrResponse } from "@shared/types/depeg-resolver";

afterEach(() => {
  vi.useRealTimers();
});

function snapshot(computedAt: number, expiresAt: number): DdrResponse {
  return {
    _meta: {
      dataAsOf: computedAt,
      modelAsOf: computedAt,
      computedAt,
      expiresAt,
      degraded: false,
      degradedReason: null,
      publicWarning: "warning",
      resolutionRubricVersion: "resolution-rubric-v1",
      durationModelVersion: "duration-landmark-v1",
      incidentGroupingVersion: "incident-group-v1",
      supportRulesVersion: "support-rules-v1",
      lineage: null,
    },
    rows: [
      {
        stablecoinId: "lusd-liquity",
        symbol: "LUSD",
        name: "Liquity USD",
        pegCurrency: "USD",
        governance: "decentralized",
        status: null,
        eventId: 1,
        startedAt: computedAt - 3600,
        ageSec: 3600,
        direction: "below",
        peakDeviationBps: -300,
        currentDeviationBps: -250,
        resolution: { tier: "at_risk", factors: [] },
        duration: {
          suppressed: false,
          suppressedReason: null,
          stratum: "below · moderate · robust · USD",
          medianSec: 3600,
          iqrSec: [1800, 7200],
          ageStatus: "ordinary",
          horizons: [
            {
              horizon: "6h",
              state: "thin_support",
              probability: 0.5,
              probabilityDisplay: "35-65%",
              probabilityInterval: { lower: 0.35, upper: 0.65 },
              rawAtRisk: 12,
              uniqueCoins: 6,
              intervalClosures: 6,
              intervalNonClosures: 6,
            },
          ],
        },
        relatedContext: {
          dewsBand: null,
          dewsScore: null,
          liquidityScore: null,
          safetyGrade: null,
          safetyScore: null,
          supplyChange7dPct: null,
          supplyChange30dPct: null,
          mintSurge: null,
        },
      },
    ],
    methodology: {
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: computedAt,
      isCurrent: true,
    },
  };
}

describe("handleDepegResolver", () => {
  it("serves stale snapshots as degraded rows with duration suppressed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000 * 1000);
    const payload = snapshot(1_998_000, 1_999_000);
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "depeg-resolver:snapshot",
            value: JSON.stringify({
              generation: DDR_SNAPSHOT_CACHE_GENERATION,
              methodologyVersion: DDR_METHODOLOGY_VERSION,
              payload,
            }),
            updated_at: payload._meta.computedAt,
          },
        ],
      },
    ]);

    const res = await handleDepegResolver(db);
    const body = (await res.json()) as DdrResponse;

    expect(res.status).toBe(200);
    expect(body._meta.degraded).toBe(true);
    expect(body._meta.degradedReason).toBe("stale-cache");
    expect(body.rows[0].resolution.tier).toBe("at_risk");
    expect(body.rows[0].duration.suppressed).toBe(true);
    expect(body.rows[0].duration.horizons).toEqual([]);
  });
});
