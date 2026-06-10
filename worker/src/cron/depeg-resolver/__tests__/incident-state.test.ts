import { describe, expect, it } from "vitest";
import { ensureCanonicalIncidentsForEvents } from "../incident-state";
import type { DdrEventDbRow } from "../types";
import type { DdrV2StoreContracts } from "../../depeg-resolver-v2-contracts";

function makeEventRow(overrides: Partial<DdrEventDbRow> = {}): DdrEventDbRow {
  return {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    peak_deviation_bps: -250,
    started_at: 1_750_000_000,
    ended_at: null,
    recovery_price: null,
    peg_reference: 1,
    source: "live",
    confirmation_sources: null,
    pending_reason: null,
    provenance_replay_run_id: null,
    provenance_replay_version: null,
    ...overrides,
  };
}

describe("ensureCanonicalIncidentsForEvents", () => {
  it("excludes quarantined events instead of assigning fallback pseudo-incidents", async () => {
    const events = [makeEventRow({ id: 1 }), makeEventRow({ id: 2, stablecoin_id: "lusd-liquity", symbol: "LUSD" })];
    const ensureCanonicalIncidents: DdrV2StoreContracts["ensureCanonicalIncidents"] =
      async (_db, inputs, options) => {
        // Event 2 needs an explicit repair migration; event 1 links cleanly.
        options.onRepairRequired?.(2, "overlaps nearby canonical incident; explicit repair required");
        const input = inputs.find((entry) => entry.eventId === 1)!;
        return [
          {
            incidentKey: "ddr2:test-incident-1",
            stablecoinId: input.stablecoinId,
            pegCurrency: input.pegCurrency,
            direction: input.direction,
            firstEventId: 1,
            currentEventId: 1,
            firstStartedAt: input.startedAt,
            currentStartedAt: input.startedAt,
            firstObservedPeakBucketBps: 200,
            incidentState: "active" as const,
            supersededByIncidentKey: null,
            sourceFingerprint: "fp",
            createdAt: input.startedAt,
            updatedAt: input.startedAt,
            eventId: 1,
            startedAt: input.startedAt,
            eligibleAt: input.startedAt,
            policyUniverseIncluded: true,
            rolloutActiveAtEnablement: false,
            confirmedAt: null,
            lockState: null,
          },
        ];
      };
    const stores = { ensureCanonicalIncidents } as DdrV2StoreContracts;

    const { byEventId, quarantined } = await ensureCanonicalIncidentsForEvents(
      stores,
      {} as D1Database,
      events,
      { ddrRunId: "run-1", runAt: 1_750_000_100 },
    );

    expect(quarantined).toEqual([
      { eventId: 2, reason: "overlaps nearby canonical incident; explicit repair required" },
    ]);
    // Event 1 keeps its canonical incident; event 2 gets NO entry — not even a
    // fallback pseudo-incident — so downstream stages skip it for this run.
    expect(byEventId.get(1)?.incidentKey).toBe("ddr2:test-incident-1");
    expect(byEventId.has(2)).toBe(false);
  });

  it("falls back to pseudo-incidents for every event when stores are absent", async () => {
    const events = [makeEventRow({ id: 7 })];
    const { byEventId, quarantined } = await ensureCanonicalIncidentsForEvents(
      null,
      {} as D1Database,
      events,
      { ddrRunId: "run-2", runAt: 1_750_000_100 },
    );

    expect(quarantined).toEqual([]);
    expect(byEventId.has(7)).toBe(true);
  });
});
