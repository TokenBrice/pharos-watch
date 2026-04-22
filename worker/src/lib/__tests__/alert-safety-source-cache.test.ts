import { describe, expect, it } from "vitest";
import {
  assessAlertSafetySourceCache,
  buildAlertSafetySourceEnvelope,
  getAlertSafetySourceGeneration,
} from "../alert-safety-source-cache";

describe("alert safety source cache", () => {
  it("builds a generation-aware envelope", () => {
    const envelope = buildAlertSafetySourceEnvelope([
      {
        id: "usdc-circle",
        name: "USD Coin",
        symbol: "USDC",
        overallGrade: "A",
        overallScore: 90,
        baseScore: 90,
        dimensions: {} as never,
        ratedDimensions: 5,
        rawInputs: {} as never,
        isDefunct: false,
      },
    ], "7.09", 1_700_000_000);

    expect(envelope.generation).toBe(getAlertSafetySourceGeneration("7.09"));
    expect(envelope.snapshot["usdc-circle"]).toEqual({
      grade: "A",
      score: 90,
      methodologyVersion: "7.09",
    });
  });

  it("marks wrong-generation and stale source snapshots explicitly", () => {
    const wrongGeneration = assessAlertSafetySourceCache(
      {
        value: JSON.stringify({
          generation: "legacy-generation",
          methodologyVersion: "7.09",
          publishedAt: 1_700_000_000,
          snapshot: {
            "usdc-circle": { grade: "A", score: 90, methodologyVersion: "7.09" },
          },
        }),
        updatedAt: 1_700_000_000,
      },
      {
        expectedGeneration: getAlertSafetySourceGeneration("7.09"),
        nowSec: 1_700_000_060,
        producerIntervalSec: 900,
      },
    );
    expect(wrongGeneration.state).toBe("wrong-generation");

    const stale = assessAlertSafetySourceCache(
      {
        value: JSON.stringify({
          generation: getAlertSafetySourceGeneration("7.09"),
          methodologyVersion: "7.09",
          publishedAt: 1_700_000_000,
          snapshot: {
            "usdc-circle": { grade: "A", score: 90, methodologyVersion: "7.09" },
          },
        }),
        updatedAt: 1_700_000_000,
      },
      {
        expectedGeneration: getAlertSafetySourceGeneration("7.09"),
        nowSec: 1_700_002_000,
        producerIntervalSec: 900,
      },
    );
    expect(stale.state).toBe("stale");
  });
});
