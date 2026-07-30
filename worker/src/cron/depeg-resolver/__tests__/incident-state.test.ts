import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import {
  applyConfirmationTimes,
  ensureCanonicalIncidentsForEvents,
  recordSystemHealthDeferrals,
} from "../incident-state";
import { toStructural } from "../utils";
import type { DdrEventDbRow } from "../types";
import type { DdrCanonicalIncident, DdrV2StoreContracts } from "../../depeg-resolver-v2-contracts";

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

describe("toStructural", () => {
  it("carries curated issuer evidence into DDR structural context", () => {
    const meta = {
      id: "fixture-usd",
      symbol: "FXD",
      name: "Fixture USD",
      flags: {
        pegCurrency: "USD",
        governance: "centralized",
      },
      mintAuthority: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        mintIncidents: [
          { date: "2026-05-24", status: "active", summary: "Compromised minter minted unbacked supply." },
          { date: "2026-05-25", status: "resolved", resolvedAt: "2026-05-26", summary: "Follow-up reviewed mint incident." },
        ],
      },
      windDownAnnouncedAt: "2026-05-24",
    } as StablecoinMeta;

    expect(toStructural(meta)).toMatchObject({
      id: "fixture-usd",
      symbol: "FXD",
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      mintIncidents: [
        { date: "2026-05-24", status: "active", resolvedAt: null },
        { date: "2026-05-25", status: "resolved", resolvedAt: "2026-05-26" },
      ],
      windDownAnnouncedAt: "2026-05-24",
    });
  });
});

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

describe("applyConfirmationTimes", () => {
  function makeIncident(overrides: Partial<DdrCanonicalIncident> = {}): DdrCanonicalIncident {
    return {
      incidentKey: "ddr2:test-incident-1",
      eventId: 1,
      currentEventId: 1,
      stablecoinId: "usdt-tether",
      pegCurrency: "USD",
      direction: "below",
      startedAt: 1_750_000_000,
      eligibleAt: 1_750_000_000,
      policyUniverseIncluded: true,
      confirmedAt: null,
      lockState: null,
      ...overrides,
    };
  }

  it("reseats both alias keys to a single shared updated reference", () => {
    // The incident is aliased under eventId=1 and currentEventId=2.
    const incident = makeIncident({ eventId: 1, currentEventId: 2 });
    const incidentsByEventId = new Map<number, DdrCanonicalIncident>([
      [1, incident],
      [2, incident],
    ]);

    applyConfirmationTimes(incidentsByEventId, new Map([[1, 1_750_500_000]]));

    const underEventId = incidentsByEventId.get(1)!;
    const underCurrentEventId = incidentsByEventId.get(2)!;
    expect(underEventId.confirmedAt).toBe(1_750_500_000);
    // Order-independence: both keys must hold the SAME object reference, not
    // two separately-cloned objects that could drift.
    expect(underCurrentEventId).toBe(underEventId);
  });

  it("ignores confirmations for events with no loaded incident", () => {
    const incidentsByEventId = new Map<number, DdrCanonicalIncident>();
    applyConfirmationTimes(incidentsByEventId, new Map([[99, 1_750_500_000]]));
    expect(incidentsByEventId.size).toBe(0);
  });
});

describe("recordSystemHealthDeferrals", () => {
  function makeIncident(overrides: Partial<DdrCanonicalIncident> = {}): DdrCanonicalIncident {
    return {
      incidentKey: "ddr2:test-incident-1",
      eventId: 1,
      currentEventId: 1,
      stablecoinId: "usdt-tether",
      pegCurrency: "USD",
      direction: "below",
      startedAt: 1_750_000_000,
      eligibleAt: 1_750_000_000,
      policyUniverseIncluded: true,
      confirmedAt: null,
      lockState: null,
      ...overrides,
    };
  }

  it("skips incidents whose lock state is already sealed or in publication flow", async () => {
    const sealedStates = ["frozen", "no_call", "publication_retry_pending", "publication_failed", "published"] as const;
    const events = [
      makeEventRow({ id: 1 }),
      ...sealedStates.map((_, index) => makeEventRow({ id: 2 + index })),
      makeEventRow({ id: 10 }),
    ];
    const incidentsByEventId = new Map<number, DdrCanonicalIncident>([
      [1, makeIncident()],
      ...sealedStates.map((lastState, index): [number, DdrCanonicalIncident] => [
        2 + index,
        makeIncident({
          incidentKey: `ddr2:test-incident-${2 + index}`,
          eventId: 2 + index,
          currentEventId: 2 + index,
          lockState: { eligibleAt: 1_750_000_000, deferralCount: 0, lastDeferralReason: null, lastState },
        }),
      ]),
      [
        10,
        makeIncident({
          incidentKey: "ddr2:test-incident-10",
          eventId: 10,
          currentEventId: 10,
          lockState: { eligibleAt: 1_750_000_000, deferralCount: 1, lastDeferralReason: null, lastState: "lock_deferred" },
        }),
      ],
    ]);
    const recordLockDeferral = vi.fn(async () => undefined);
    const stores = { recordLockDeferral } as unknown as DdrV2StoreContracts;

    const count = await recordSystemHealthDeferrals({
      stores,
      db: {} as D1Database,
      incidentsByEventId,
      activeRows: events,
      nowSec: 1_750_100_000,
      ddrRunId: "run-3",
      runAt: 1_750_100_000,
      syncCapabilities: {},
      reason: "stablecoins-cache-unsafe",
    });

    // Only the never-locked and lock_deferred incidents get a deferral write;
    // sealed/publication-flow incidents are immutable per the D1 lock-state trigger.
    expect(count).toBe(2);
    const deferredKeys = recordLockDeferral.mock.calls.map(
      (call) => (call as unknown as [unknown, { incidentKey: string }])[1].incidentKey,
    );
    expect(deferredKeys).toEqual(["ddr2:test-incident-1", "ddr2:test-incident-10"]);
  });
});
