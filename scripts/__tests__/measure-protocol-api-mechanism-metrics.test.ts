import { describe, expect, it } from "vitest";

import {
  buildEthenaProtocolApiMeasurement,
  ProtocolApiMechanismMeasurementSchema,
} from "../lib/mechanism-measurement/protocol-api";

const CAPTURED_AT = new Date("2026-07-22T20:05:00.000Z");

function status(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-07-22 20:00:16.250683 UTC",
    totalBackingAssetsInUsd: 4_032_944_678.04,
    totalReserveFundInUsd: 62_097_782.084185585,
    totalTokenSupplyInUsd: 4_028_272_966.14659,
    ...overrides,
  };
}

function por(overrides: Record<string, unknown> = {}) {
  return {
    lastUpdatedAt: "2026-07-17T00:06:43.000Z",
    reports: [
      {
        auditors: [
          { name: "HarrisAndTrotter", is_confirmed: true },
          { name: "Chainlink", is_confirmed: true },
          { name: "LlamaRisk", is_confirmed: true },
        ],
        date: "2026-07-17T00:06:43.000Z",
        deltaNeutral: true,
        overCollateralized: true,
      },
    ],
    ...overrides,
  };
}

describe("Ethena protocol API mechanism measurement", () => {
  it("derives replayable producer evidence from current protocol payloads", () => {
    const evidence = buildEthenaProtocolApiMeasurement({
      collateralizationStatus: status(),
      proofOfReserves: por(),
      capturedAt: CAPTURED_AT,
    });

    expect(ProtocolApiMechanismMeasurementSchema.parse(evidence)).toEqual(evidence);
    expect(evidence.derived).toMatchObject({
      deltaNeutralAttested: true,
      overCollateralizedAttested: true,
      confirmedAuditors: ["Chainlink", "HarrisAndTrotter", "LlamaRisk"],
    });
    expect(evidence.metrics.hedgeCoverageRatio).toBeNull();
    expect(evidence.metrics.liquidationCapacityUsd).toBeNull();
    expect(evidence.metrics.marginBufferPct).toBeCloseTo(0.115973, 6);
    expect(evidence.metrics.lossAbsorptionShare).toBeCloseTo(0.015415, 6);

    const replayed = buildEthenaProtocolApiMeasurement({
      collateralizationStatus: evidence.observations.collateralizationStatus.payload,
      proofOfReserves: evidence.observations.proofOfReserves.payload,
      capturedAt: new Date(evidence.capturedAt),
    });
    expect(replayed).toEqual(evidence);
  });

  it("records adverse attestations without inventing quantitative hedge coverage", () => {
    const evidence = buildEthenaProtocolApiMeasurement({
      collateralizationStatus: status({ totalBackingAssetsInUsd: 3_900_000_000 }),
      proofOfReserves: por({
        lastUpdatedAt: "2026-07-17T00:06:43.000Z",
        reports: [
          {
            auditors: [{ name: "LlamaRisk", is_confirmed: true }],
            date: "2026-07-17T00:06:43.000Z",
            deltaNeutral: false,
            overCollateralized: false,
          },
        ],
      }),
      capturedAt: CAPTURED_AT,
    });

    expect(evidence.derived.deltaNeutralAttested).toBe(false);
    expect(evidence.metrics.hedgeCoverageRatio).toBeNull();
    expect(evidence.metrics.liquidationCapacityUsd).toBeNull();
    expect(evidence.metrics.marginBufferPct).toBe(0);
  });

  it("fails closed on stale status, stale PoR, and unconfirmed reports", () => {
    expect(() =>
      buildEthenaProtocolApiMeasurement({
        collateralizationStatus: status({ timestamp: "2026-07-21 01:00:00 UTC" }),
        proofOfReserves: por(),
        capturedAt: CAPTURED_AT,
      }),
    ).toThrow(/status is stale/);

    expect(() =>
      buildEthenaProtocolApiMeasurement({
        collateralizationStatus: status(),
        proofOfReserves: por({
          lastUpdatedAt: "2026-07-01T00:00:00.000Z",
          reports: [
            {
              auditors: [{ name: "LlamaRisk", is_confirmed: true }],
              date: "2026-07-01T00:00:00.000Z",
              deltaNeutral: true,
              overCollateralized: true,
            },
          ],
        }),
        capturedAt: CAPTURED_AT,
      }),
    ).toThrow(/proof of reserves is stale/);

    expect(() =>
      buildEthenaProtocolApiMeasurement({
        collateralizationStatus: status(),
        proofOfReserves: por({
          reports: [
            {
              auditors: [{ name: "LlamaRisk", is_confirmed: false }],
              date: "2026-07-17T00:06:43.000Z",
              deltaNeutral: true,
              overCollateralized: true,
            },
          ],
        }),
        capturedAt: CAPTURED_AT,
      }),
    ).toThrow(/no confirmed auditor/);
  });
});
