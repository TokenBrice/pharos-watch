import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { createV9EvidenceReference } from "@shared/lib/safety-score-v9/evidence";
import { buildRedemptionBackstopEntry } from "../redemption-backstop/sources";
import { liveSnapshot } from "./redemption-backstop-sources.test-support";

const now = 1_790_467_200;

describe("retained redemption evidence", () => {
  it.each([0, 9, 40, 47.9])("keeps a %sh producing clock separate from publication", async (hours) => {
    const observedAt = now - hours * 3600;
    const entry = await buildRedemptionBackstopEntry(
      {} as D1Database, "lusd-liquity", getRedemptionBackstopConfig("lusd-liquity")!,
      10_000_000, null, now,
      { reserveSnapshotMetadata: liveSnapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: { capacityUsd: 10_000_000, capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain", feeBps: 50, routeStatus: "open", routeStatusSource: "onchain" },
      }, { fetchedAt: observedAt, source: "liquity-v1", sourceModel: "single-bucket" }) },
    );
    const observation = entry.capacityProfile?.exitRouteObservations?.[0];
    expect(entry.updatedAt).toBe(now);
    expect(observation?.observedAt).toBe(observedAt);
    expect(observation?.freshnessSeconds).toBe(hours * 3600);
    const evidence = createV9EvidenceReference({
      evidenceId: "lusd:route", sourceId: "report-cards-redemption-route-observation",
      sourceGenerationId: "test-generation", disposition: "observed",
      observedAtSec: observation!.observedAt, maxAgeSec: 8 * 3600,
    }, now);
    expect(evidence.freshness.state).toBe(hours > 8 ? "stale" : "current");
  });
});
