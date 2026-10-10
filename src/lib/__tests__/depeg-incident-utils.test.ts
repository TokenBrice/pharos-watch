import { describe, expect, it } from "vitest";
import { DepegPendingIncidentSchema } from "@shared/types";
import { makePendingIncident } from "@/components/__tests__/depeg.test-support";
import { extractPendingDepegIncidents, mapPendingIncidentsByCoin } from "../depeg-incident-utils";

describe("extractPendingDepegIncidents", () => {
  it("returns no incidents before data arrives or when pending is absent", () => {
    expect(extractPendingDepegIncidents(undefined)).toEqual([]);
    expect(extractPendingDepegIncidents({})).toEqual([]);
    expect(extractPendingDepegIncidents({ pending: [] })).toEqual([]);
  });

  it("sorts validated incidents by largest absolute peak, then most recent firstSeenAt without mutating data", () => {
    const pending = [
      makePendingIncident({ stablecoinId: "older-tie", firstSeenAt: 10, peakSeenBps: 200 }),
      makePendingIncident({ stablecoinId: "largest", firstSeenAt: 20, peakSeenBps: -250 }),
      makePendingIncident({ stablecoinId: "newer-tie", firstSeenAt: 30, peakSeenBps: -200 }),
      makePendingIncident({ stablecoinId: "smallest", firstSeenAt: 40, peakSeenBps: -120 }),
    ].map((incident) => DepegPendingIncidentSchema.parse(incident));
    const original = [...pending];
    const incidents = extractPendingDepegIncidents({ pending });

    expect(incidents.map((incident) => incident.stablecoinId)).toEqual([
      "largest", "newer-tie", "older-tie", "smallest",
    ]);
    expect(pending).toEqual(original);
    expect(incidents[0]).toBe(pending[1]);
    expect(incidents[0]?.availableConfirmationCategories).toEqual(["cex", "dex"]);
    expect(incidents[0]?.missingConfirmationCategories).toEqual(["native"]);
  });
});

describe("mapPendingIncidentsByCoin", () => {
  it("uses last-write-wins behavior for duplicate stablecoin ids", () => {
    const first = makePendingIncident({ stablecoinId: "coin-a", symbol: "A1", firstSeenAt: 1 });
    const second = makePendingIncident({ stablecoinId: "coin-a", symbol: "A2", direction: "above", firstSeenAt: 2 });
    const mapped = mapPendingIncidentsByCoin([first, second]);

    expect(mapped.get("coin-a")).toBe(second);
  });
});
