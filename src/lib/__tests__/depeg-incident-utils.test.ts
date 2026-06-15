import { describe, expect, it } from "vitest";
import {
  extractPendingDepegIncidents,
  mapPendingIncidentsByCoin,
  type PendingDepegIncident,
} from "../depeg-incident-utils";

function pending(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    stablecoinId: "coin-a",
    symbol: "A",
    direction: "below",
    firstSeenAt: 1_700_000_000,
    peakSeenBps: -120,
    confirmationCategories: ["cex", 12, "dex"],
    missingConfirmationCategories: ["llama", null, "native"],
    ...overrides,
  };
}

describe("extractPendingDepegIncidents", () => {
  it.each(["pendingIncidents", "pendingDepegs", "pending"] as const)(
    "reads pending incidents from %s",
    (key) => {
      const incidents = extractPendingDepegIncidents({ [key]: [pending()] });

      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        stablecoinId: "coin-a",
        symbol: "A",
        direction: "below",
        firstSeenAt: 1_700_000_000,
        peakSeenBps: -120,
        confirmationCategories: ["cex", "dex"],
        missingConfirmationCategories: ["llama", "native"],
      });
    },
  );

  it("drops malformed pending incidents", () => {
    const incidents = extractPendingDepegIncidents({
      pendingIncidents: [
        pending({ stablecoinId: undefined }),
        pending({ firstSeenAt: null }),
        pending({ direction: "sideways" }),
        pending({ stablecoinId: "valid", symbol: undefined }),
      ],
    });

    expect(incidents.map((incident) => incident.stablecoinId)).toEqual(["valid"]);
    expect(incidents[0]?.symbol).toBe("valid");
  });

  it("sorts by largest absolute peak, then most recent firstSeenAt", () => {
    const incidents = extractPendingDepegIncidents({
      pending: [
        pending({ stablecoinId: "older-tie", firstSeenAt: 10, peakSeenBps: 200 }),
        pending({ stablecoinId: "largest", firstSeenAt: 20, peakSeenBps: -250 }),
        pending({ stablecoinId: "newer-tie", firstSeenAt: 30, peakSeenBps: -200 }),
        pending({ stablecoinId: "fallback-last", firstSeenAt: 40, peakSeenBps: null, lastSeenBps: 50 }),
      ],
    });

    expect(incidents.map((incident) => incident.stablecoinId)).toEqual([
      "largest",
      "newer-tie",
      "older-tie",
      "fallback-last",
    ]);
  });
});

describe("mapPendingIncidentsByCoin", () => {
  it("uses last-write-wins behavior for duplicate stablecoin ids", () => {
    const first: PendingDepegIncident = {
      stablecoinId: "coin-a",
      symbol: "A1",
      direction: "below",
      firstSeenAt: 1,
    };
    const second: PendingDepegIncident = {
      stablecoinId: "coin-a",
      symbol: "A2",
      direction: "above",
      firstSeenAt: 2,
    };

    const mapped = mapPendingIncidentsByCoin([first, second]);

    expect(mapped.get("coin-a")).toBe(second);
  });
});
