import { describe, expect, it } from "vitest";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
import { StablecoinReservesResponseSchema } from "@shared/types/live-reserves";
import { makeReservesDb } from "./live-reserves-store.test-support";
import { resolveReserveResult } from "../live-reserves/store";
import { assessReserveSnapshotFreshness } from "../live-reserves/store-snapshot-state";

const DAY = 86_400;
const now = 1_800_000_000;
const FETCH_BUDGET = 2 * DAY;

const infinifi = TRACKED_META_BY_ID.get("iusd-infinifi")!;
const usyc = TRACKED_META_BY_ID.get("usyc-hashnote")!;
const infinifiDefinition = getLiveReserveAdapterDefinition(infinifi.liveReservesConfig!.adapter);
const INFINIFI_ADAPTER_CAP = infinifiDefinition && "validation" in infinifiDefinition
  && infinifiDefinition.validation && "maxSourceAgeSec" in infinifiDefinition.validation
  ? infinifiDefinition.validation.maxSourceAgeSec
  : undefined;

function withScoringCap(coin: StablecoinMeta, maxSourceAgeSec: number | undefined): StablecoinMeta {
  return {
    ...coin,
    liveReservesConfig: { ...coin.liveReservesConfig!, scoring: maxSourceAgeSec == null ? undefined : { maxSourceAgeSec } },
  };
}

function verifiedSnapshot(sourceAgeSec: number, fetchAgeSec = 60) {
  return {
    fetchedAt: now - fetchAgeSec,
    attemptId: "attempt-1",
    metadata: { freshnessMode: "verified" as const, sourceTimestamp: now - sourceAgeSec },
  };
}

describe("reserve freshness assessment publishes the budgets its verdict used", () => {
  const adapterCap = INFINIFI_ADAPTER_CAP!;
  it.each([
    ["adapter cap, no coin cap", withScoringCap(infinifi, undefined), adapterCap, "adapter"],
    // Config review rejects widening, but the evaluator itself must still take the minimum.
    ["adapter cap tighter than coin cap", withScoringCap(infinifi, adapterCap + DAY), adapterCap, "adapter"],
    ["coin cap tighter than adapter cap", withScoringCap(infinifi, adapterCap - 3_600), adapterCap - 3_600, "scoring"],
    ["coin cap equal to adapter cap", withScoringCap(infinifi, adapterCap), adapterCap, "scoring"],
    ["coin cap without adapter cap", withScoringCap(usyc, 4 * DAY), 4 * DAY, "scoring"],
    ["no declared cap", withScoringCap(usyc, undefined), FETCH_BUDGET, "fetch-budget"],
  ] as const)("%s: age == budget is fresh, budget + 1 is stale", (_label, coin, budget, cap) => {
    expect(assessReserveSnapshotFreshness(verifiedSnapshot(budget), coin, now, FETCH_BUDGET)).toEqual({
      stale: false,
      staleReasons: [],
      assessedAt: now,
      fetchedAt: now - 60,
      attemptId: "attempt-1",
      fetchAgeSec: 60,
      fetchBudgetSec: FETCH_BUDGET,
      sourceTimestamp: now - budget,
      sourceAgeSec: budget,
      sourceAgeBudgetSec: budget,
      sourceAgeBudgetCap: cap,
    });
    expect(assessReserveSnapshotFreshness(verifiedSnapshot(budget + 1), coin, now, FETCH_BUDGET)).toMatchObject({
      stale: true,
      staleReasons: ["source-age"],
      sourceAgeSec: budget + 1,
      sourceAgeBudgetSec: budget,
      sourceAgeBudgetCap: cap,
    });
  });

  it("judges fetch age against the caller's budget and reports both expiries", () => {
    const coin = withScoringCap(usyc, 4 * DAY);
    expect(assessReserveSnapshotFreshness(verifiedSnapshot(60, 300), coin, now, 300)).toMatchObject({
      stale: false, fetchAgeSec: 300, fetchBudgetSec: 300,
    });
    expect(assessReserveSnapshotFreshness(verifiedSnapshot(4 * DAY + 1, 301), coin, now, 300)).toMatchObject({
      stale: true, staleReasons: ["fetch-age", "source-age"], fetchAgeSec: 301, fetchBudgetSec: 300,
    });
  });

  it("publishes no source budget when source age does not take part in the verdict", () => {
    const assessment = assessReserveSnapshotFreshness(
      { fetchedAt: now - 60, metadata: { freshnessMode: "unverified", sourceTimestamp: now - 365 * DAY } },
      withScoringCap(usyc, 4 * DAY),
      now,
      FETCH_BUDGET,
    );
    expect(assessment).toMatchObject({
      stale: false,
      attemptId: null,
      sourceTimestamp: null,
      sourceAgeSec: null,
      sourceAgeBudgetSec: null,
      sourceAgeBudgetCap: null,
    });
  });
});

describe("resolveReserveResult publishes the evaluator's freshness beside its verdicts", () => {
  const fetchBudget = 300;

  function db(fetchAgeSec: number, sourceAgeSec: number) {
    return makeReservesDb({
      composition: {
        fetched_at: now - fetchAgeSec,
        attempt_id: "attempt-7",
        metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: now - sourceAgeSec }),
      },
      syncState: {
        last_attempted_at: now - fetchAgeSec,
        last_success_at: now - fetchAgeSec,
        last_attempt_id: "attempt-7",
        last_success_attempt_id: "attempt-7",
      },
    });
  }

  it("serves exactly the evaluated budgets, clock, and generation at both boundaries", async () => {
    const adapterCap = INFINIFI_ADAPTER_CAP!;
    const fresh = await resolveReserveResult(db(fetchBudget, adapterCap), "iusd-infinifi", now, fetchBudget);
    const expected = assessReserveSnapshotFreshness(
      { fetchedAt: now - fetchBudget, attemptId: "attempt-7", metadata: { freshnessMode: "verified", sourceTimestamp: now - adapterCap } },
      infinifi,
      now,
      fetchBudget,
    );
    expect(fresh?.mode).toBe("live");
    expect(fresh?.sync?.stale).toBe(false);
    expect(fresh?.sync?.freshness).toEqual(expected);
    expect(fresh?.sync?.freshness).toEqual({
      stale: false,
      staleReasons: [],
      assessedAt: now,
      fetchedAt: now - fetchBudget,
      attemptId: "attempt-7",
      fetchAgeSec: fetchBudget,
      fetchBudgetSec: fetchBudget,
      sourceTimestamp: now - adapterCap,
      sourceAgeSec: adapterCap,
      sourceAgeBudgetSec: adapterCap,
      sourceAgeBudgetCap: "adapter",
    });
    expect(fresh?.provenance?.scoringRejectionReasons).not.toContain("stale");
    expect(() => StablecoinReservesResponseSchema.parse({ stablecoinId: "iusd-infinifi", ...fresh })).not.toThrow();

    const fetchExpired = await resolveReserveResult(db(fetchBudget + 1, adapterCap), "iusd-infinifi", now, fetchBudget);
    expect(fetchExpired?.mode).toBe("live-stale");
    expect(fetchExpired?.sync).toMatchObject({
      stale: true,
      freshness: { stale: true, staleReasons: ["fetch-age"], fetchAgeSec: fetchBudget + 1, fetchBudgetSec: fetchBudget },
    });
    expect(fetchExpired?.provenance?.scoringRejectionReasons).toContain("stale");

    const sourceExpired = await resolveReserveResult(db(fetchBudget, adapterCap + 1), "iusd-infinifi", now, fetchBudget);
    expect(sourceExpired?.mode).toBe("live-stale");
    expect(sourceExpired?.sync?.freshness).toMatchObject({
      stale: true, staleReasons: ["source-age"], sourceAgeSec: adapterCap + 1, sourceAgeBudgetSec: adapterCap,
    });
    expect(sourceExpired?.provenance?.scoringRejectionReasons).toContain("stale");
  });

  it("describes the rejected generation on fallback responses with a null legacy attempt", async () => {
    const result = await resolveReserveResult(makeReservesDb({
      composition: { slices: "not json", fetched_at: now - fetchBudget - 1 },
      syncState: { last_attempted_at: now - fetchBudget - 1, last_success_at: now - fetchBudget - 1 },
    }), "iusd-infinifi", now, fetchBudget);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync).toMatchObject({ stale: true });
    expect(result?.sync?.freshness).toEqual({
      stale: true,
      staleReasons: ["fetch-age"],
      assessedAt: now,
      fetchedAt: now - fetchBudget - 1,
      attemptId: null,
      fetchAgeSec: fetchBudget + 1,
      fetchBudgetSec: fetchBudget,
      sourceTimestamp: null,
      sourceAgeSec: null,
      sourceAgeBudgetSec: null,
      sourceAgeBudgetCap: null,
    });
  });
});
