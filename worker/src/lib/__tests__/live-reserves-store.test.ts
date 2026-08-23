import { describe, expect, it } from "vitest";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import {
  LIVE_SLICES,
  makeReservesDb,
  mockReserveD1 as mockD1,
  reserveCompositionRow,
  reserveSyncRow,
} from "./live-reserves-store.test-support";
import { LIVE_RESERVE_RUN_CURSOR_CACHE_KEY } from "../operational-cache-keys";
import {
  computeReserveCompositionOverview,
  getMaxSyncAge,
  loadLiveReserveHistoryWriteGaps,
  loadFreshIndependentLiveReserveMap,
  resolveReserveResult,
} from "../live-reserves-store";
import { getConfiguredLiveReserveCoins } from "../live-reserves-store-shared";

describe("live-reserves-store", () => {
  it("computes max sync age from the oldest required reserve attempt", async () => {
    const db = mockD1([
      {
        match: "SELECT MIN(last_attempted_at) AS oldest_ts",
        rows: [],
        first: { oldest_ts: 950, observed_count: 1 },
      },
    ]);

    await expect(getMaxSyncAge(db, 1_000)).resolves.toBe(50);
  });

  it("treats a missing required reserve state row as infinitely stale", async () => {
    const db = mockD1([
      {
        match: "FROM reserve_sync_state",
        rows: [reserveSyncRow({ stablecoin_id: "coin-a", adapter_key: "test", breaker_key: "test", last_attempted_at: 950, last_success_at: 950 })],
      },
    ]);

    await expect(getMaxSyncAge(db, 1_000, ["coin-a", "coin-b"])).resolves.toBe(Infinity);
  });

  it("chunks configured reserve state reads within the D1 bind limit", async () => {
    const stablecoinIds = Array.from({ length: 181 }, (_, index) => `coin-${index}`);
    const db = mockD1([
      {
        match: "FROM reserve_sync_state",
        rows: stablecoinIds.map((stablecoinId, index) => reserveSyncRow({
          stablecoin_id: stablecoinId,
          adapter_key: "test",
          breaker_key: "test",
          last_attempted_at: 900 + index,
          last_success_at: 900 + index,
        })),
      },
    ]);

    await expect(getMaxSyncAge(db, 1_000, stablecoinIds)).resolves.toBe(100);
    const reserveQueries = db.getHistory().filter((entry) => entry.sql.includes("FROM reserve_sync_state"));
    expect(reserveQueries).toHaveLength(3);
    expect(reserveQueries.every((entry) => entry.binds.length <= 90)).toBe(true);
  });

  it("falls back when reserve composition exists without a matching successful sync state", async () => {
    const db = makeReservesDb({
      syncState: null,
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

    expect(result?.mode).toBe("curated-fallback");
    expect(result?.liveAt).toBeUndefined();
  });

  it("returns live data only when composition and sync state agree on the last successful snapshot", async () => {
    const db = makeReservesDb();

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

    expect(result).toMatchObject({
      mode: "live",
      liveAt: 1_000,
      reserves: LIVE_SLICES,
      displayBadge: {
        kind: "live",
        label: "Live",
      },
      provenance: {
        evidenceClass: "independent",
        sourceModel: "dynamic-mix",
        scoringEligible: false,
      },
      sync: {
        status: "ok",
        bootstrap: false,
        stale: false,
      },
    });

    const staleSourceWarning = {
      code: "stale-source-data",
      message: "Upstream reserve source timestamp is older than the accepted maximum",
      severity: "warning",
      effect: "degraded",
    };
    const staleSourceDb = makeReservesDb({
      composition: {
        fetched_at: 1_100,
        metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: 700 }),
      },
      syncState: {
        last_attempted_at: 1_100,
        last_success_at: 1_100,
        last_status: "degraded",
        warning_count: 1,
        warnings: JSON.stringify([staleSourceWarning]),
      },
    });
    const staleSourceResult = await resolveReserveResult(staleSourceDb, "iusd-infinifi", 1_200, 300);
    expect(staleSourceResult).toMatchObject({
      mode: "curated-fallback",
      sync: {
        status: "degraded",
        stale: true,
        warnings: [staleSourceWarning.message],
      },
    });
    expect(staleSourceResult?.reserves).not.toEqual(LIVE_SLICES);

    const staleObservationWithOkStatus = makeReservesDb({
      composition: {
        fetched_at: 1_100,
        metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: 700 }),
      },
      syncState: { last_attempted_at: 1_100, last_success_at: 1_100 },
    });
    await expect(
      resolveReserveResult(staleObservationWithOkStatus, "iusd-infinifi", 1_200, 300),
    ).resolves.toMatchObject({ mode: "curated-fallback", sync: { stale: true } });

    const degradedFreshDb = makeReservesDb({ syncState: { last_status: "degraded" } });
    await expect(resolveReserveResult(degradedFreshDb, "iusd-infinifi", 1_200)).resolves.toMatchObject({
      mode: "curated-fallback",
      sync: { status: "degraded", stale: false },
    });
  });

  it("does not mark unverified snapshots without explicit scoring exceptions as scoring eligible", async () => {
    const db = makeReservesDb({
      composition: {
        metadata: JSON.stringify({ freshnessMode: "unverified", sourceTimestamp: 1_000 }),
        adapter_source_model: "dynamic-mix",
        adapter_evidence_class: "independent",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

    expect(result?.mode).toBe("live");
    expect(result?.provenance).toMatchObject({
      evidenceClass: "independent",
      freshnessMode: "unverified",
      scoringEligible: false,
    });
  });

  it("keeps unverified snapshots non-score-grade even with legacy freshness exception flags", async () => {
    const db = makeReservesDb({
      composition: {
        metadata: JSON.stringify({
          freshnessMode: "unverified",
          sourceTimestamp: 1_000,
          scoringAllowsUnverifiedFreshness: true,
        }),
        adapter_source_model: "dynamic-mix",
        adapter_evidence_class: "independent",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

    expect(result?.provenance).toMatchObject({
      evidenceClass: "independent",
      freshnessMode: "unverified",
      scoringEligible: false,
    });
  });

  // Badge/provenance mapping is a pure function of the stored adapter columns, so
  // these cases vary only values — the wiring is identical.
  it.each([
    {
      label: "curated-validated adapters map to a curated-validated badge",
      stablecoinId: "frax-frax",
      adapterKey: "frax",
      slices: [{ name: "Reviewed baseline", pct: 100, risk: "low" }],
      freshnessMode: "unverified",
      sourceTimestamp: undefined,
      sourceModel: "validated-static",
      evidenceClass: "static-validated",
      badge: { kind: "curated-validated", label: "Curated-Validated" },
    },
    {
      label: "live-fed adapters keep live badge semantics even when evidence class is static-validated",
      stablecoinId: "usdd-tron-dao-reserve",
      adapterKey: "usdd-data-platform",
      slices: [{ name: "Tracked vaults", pct: 100, risk: "medium" }],
      freshnessMode: "verified",
      sourceTimestamp: 1_000,
      sourceModel: "dynamic-mix",
      evidenceClass: "static-validated",
      badge: { kind: "live", label: "Live" },
    },
    {
      label: "single-asset adapters map to a proof badge",
      stablecoinId: "pyusd-paypal",
      adapterKey: "single-asset",
      slices: [{ name: "Issuer reserves", pct: 100, risk: "very-low" }],
      freshnessMode: "not-applicable",
      sourceTimestamp: undefined,
      sourceModel: "single-bucket",
      evidenceClass: "weak-live-probe",
      badge: { kind: "proof", label: "Proof" },
    },
    {
      label: "Liquity v1 system collateral adapters map to a live badge",
      stablecoinId: "lusd-liquity",
      adapterKey: "liquity-v1",
      breakerKey: "live-reserves:lusd-liquity",
      slices: [{ name: "ETH", pct: 100, risk: "very-low" }],
      freshnessMode: "not-applicable",
      sourceTimestamp: undefined,
      sourceModel: "single-bucket",
      evidenceClass: "independent",
      badge: { kind: "live", label: "Live" },
    },
  ])("$label", async (testCase) => {
    const db = makeReservesDb({
      composition: {
        stablecoin_id: testCase.stablecoinId,
        slices: JSON.stringify(testCase.slices),
        source: testCase.adapterKey,
        metadata: JSON.stringify({
          freshnessMode: testCase.freshnessMode,
          ...(testCase.sourceTimestamp === undefined ? {} : { sourceTimestamp: testCase.sourceTimestamp }),
        }),
        adapter_source_model: testCase.sourceModel,
        adapter_evidence_class: testCase.evidenceClass,
      },
      syncState: {
        stablecoin_id: testCase.stablecoinId,
        adapter_key: testCase.adapterKey,
        breaker_key: testCase.breakerKey ?? `live-reserves:${testCase.adapterKey}`,
      },
    });

    const result = await resolveReserveResult(db, testCase.stablecoinId, 1_200);

    expect(result).toMatchObject({
      mode: "live",
      displayBadge: testCase.badge,
      provenance: {
        evidenceClass: testCase.evidenceClass,
        sourceModel: testCase.sourceModel,
        freshnessMode: testCase.freshnessMode,
      },
    });
  });

  it("treats inconsistent live snapshots as missing in the reserve overview", async () => {
    const emptyOverview = await computeReserveCompositionOverview(mockD1(), 2_000);
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow()],
      },
      {
        match: "reserve_composition",
        rows: [{
          ...reserveCompositionRow({ fetched_at: 999 }),
        }],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, 2_000);

    // Inconsistent snapshot (sync.last_success_at !== composition.fetched_at) is treated as missing.
    // The coin was already counted as missing in the empty overview, so counts don't change.
    // Before the double-count fix, this coin was counted in BOTH missing AND degraded.
    expect(overview.missingCoins).toBe(emptyOverview.missingCoins);
    expect(overview.freshCoins).toBe(0);
    expect(overview.degradedCoins).toBe(emptyOverview.degradedCoins);
  });

  it("rejects attempt-stamped snapshots when sync state points to a different successful attempt", async () => {
    const db = makeReservesDb({
      composition: {
        attempt_id: "attempt-a",
      },
      syncState: {
        last_attempt_id: "attempt-b",
        pending_attempt_id: null,
        last_success_attempt_id: "attempt-b",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.liveAt).toBeUndefined();
  });

  it("fails closed on malformed stored slices and falls back instead of serving them as live", async () => {
    const now = Math.floor(Date.now() / 1000);
    const corruptSlices = [
      { name: "Valid Farm", pct: 60, risk: "low" },
      { name: "Missing Risk", pct: 20 },
      { pct: 10, risk: "medium" },
      { name: "Bad Pct", pct: "fifty", risk: "low" },
      { name: "Valid Too", pct: 10, risk: "high" },
    ];

    const db = makeReservesDb({
      composition: {
        slices: JSON.stringify(corruptSlices),
        fetched_at: now,
      },
      syncState: {
        last_attempted_at: now,
        last_success_at: now,
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync?.status).toBe("degraded");
    expect(result?.sync?.lastError).toContain("Stored live reserve snapshot rejected");
  });

  it("treats an unknown stored adapter key as corrupt data instead of crashing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeReservesDb({
      composition: {
        fetched_at: now,
        source: "removed-adapter-key",
        attempt_id: "attempt-1",
        metadata: "{}",
        warning_count: 0,
      },
      syncState: {
        adapter_key: "removed-adapter-key",
        breaker_key: "live-reserves:removed-adapter-key",
        last_attempted_at: now,
        last_success_at: now,
        last_attempt_id: "attempt-1",
        pending_attempt_id: null,
        last_success_attempt_id: "attempt-1",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync?.status).toBe("degraded");
    expect(result?.sync?.lastError).toContain("Stored live reserve snapshot rejected");
  });

  it("separates error coins from degraded coins in the overview", async () => {
    const now = 2_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow({ last_attempted_at: now, last_success_at: now, last_status: "error", last_error: "HTTP 503" })],
      },
      {
        match: "reserve_composition",
        rows: [reserveCompositionRow({ fetched_at: now })],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now + 100);
    // errorCoins must exist on the type and be a number
    expect(typeof overview.errorCoins).toBe("number");
    // The error coin should be counted, not in degraded
    expect(overview.errorCoins).toBeGreaterThanOrEqual(1);
  });

  it("counts pre-bootstrap adapter failures as error coins instead of missing coins", async () => {
    const emptyOverview = await computeReserveCompositionOverview(mockD1(), 2_000);
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow({ last_attempted_at: 2_000, last_success_at: null, last_status: "error", last_error: "HTTP 503" })],
      },
      {
        match: "reserve_composition",
        rows: [],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, 2_100);
    expect(overview.errorCoins).toBe(emptyOverview.errorCoins + 1);
    expect(overview.missingCoins).toBe(emptyOverview.missingCoins - 1);
  });

  it("prioritizes active sync errors over stale classification in the overview", async () => {
    const now = 10_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow({ last_attempted_at: now, last_success_at: 1_000, last_status: "error", last_error: "HTTP 503" })],
      },
      {
        match: "reserve_composition",
        rows: [reserveCompositionRow()],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);
    expect(overview.errorCoins).toBeGreaterThanOrEqual(1);
    expect(overview.staleCoins).toBe(0);
  });

  it("includes lastError in sync view when sync state has an error", async () => {
    const db = makeReservesDb({
      syncState: {
        last_status: "error",
        last_error: "HTTP 503 for https://api.example.com",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.reserves).not.toEqual(LIVE_SLICES);
    expect(result?.sync?.lastError).toBe("HTTP 503 for https://api.example.com");
  });

  it("rejects stored snapshots with invalid risk enum values during resolution", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeReservesDb({
      composition: {
        slices: JSON.stringify([
          { name: "Good", pct: 60, risk: "low" },
          { name: "Bad", pct: 40, risk: "bogus" },
        ]),
        fetched_at: now,
      },
      syncState: {
        last_attempted_at: now,
        last_success_at: now,
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync?.status).toBe("degraded");
    expect(result?.sync?.lastError).toContain("Stored live reserve snapshot rejected");
  });

  it("rejects stored snapshots with negative pct during resolution", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeReservesDb({
      composition: {
        slices: JSON.stringify([
          { name: "Valid", pct: 80, risk: "medium" },
          { name: "Negative", pct: -10, risk: "low" },
          { name: "Zero", pct: 0, risk: "high" },
        ]),
        fetched_at: now,
      },
      syncState: {
        last_attempted_at: now,
        last_success_at: now,
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync?.status).toBe("degraded");
    expect(result?.sync?.lastError).toContain("Stored live reserve snapshot rejected");
  });

  it("ignores malformed warning and metadata JSON in sync state rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeReservesDb({
      composition: {
        fetched_at: now,
      },
      syncState: {
        last_attempted_at: now,
        last_success_at: now,
        warning_count: 1,
        warnings: "{bad json",
        metadata: "{bad json",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 60);

    expect(result).toMatchObject({
      mode: "live",
      sync: {
        status: "ok",
        bootstrap: false,
        stale: false,
      },
    });
    expect(result?.sync).not.toHaveProperty("warnings");
  });

  it("uses only independent ok-status live reserve snapshots for scoring passthrough", async () => {
    const now = 10_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          reserveSyncRow({
            last_attempted_at: now,
            last_success_at: now,
            last_status: "degraded",
            warning_count: 1,
            warnings: JSON.stringify([{ code: "unknown-position", message: "warn", severity: "warning" }]),
          }),
          reserveSyncRow({
            stablecoin_id: "pyusd-paypal",
            adapter_key: "single-asset",
            breaker_key: "live-reserves:single-asset",
            last_attempted_at: now,
            last_success_at: now,
          }),
          reserveSyncRow({
            stablecoin_id: "lusd-liquity",
            adapter_key: "liquity-v1",
            breaker_key: "live-reserves:lusd-liquity",
            last_attempted_at: now,
            last_success_at: now,
          }),
        ],
      },
      {
        match: "reserve_composition",
        rows: [
          reserveCompositionRow({ slices: JSON.stringify([{ name: "Known Farm", pct: 100, risk: "low" }]), fetched_at: now }),
          reserveCompositionRow({
            stablecoin_id: "pyusd-paypal",
            slices: JSON.stringify([{ name: "Issuer reserves", pct: 100, risk: "very-low" }]),
            fetched_at: now,
            source: "single-asset",
          }),
          reserveCompositionRow({
            stablecoin_id: "lusd-liquity",
            slices: JSON.stringify([{ name: "ETH", pct: 100, risk: "very-low" }]),
            fetched_at: now,
            source: "liquity-v1",
            metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
            adapter_source_model: "single-bucket",
            adapter_evidence_class: "independent",
          }),
        ],
      },
    ]);

    const scoringMap = await loadFreshIndependentLiveReserveMap(db, now + 100);
    expect(scoringMap.has("iusd-infinifi")).toBe(false);
    expect(scoringMap.has("pyusd-paypal")).toBe(false);
    expect(scoringMap.get("lusd-liquity")).toEqual([{ name: "ETH", pct: 100, risk: "very-low" }]);
  });

  it("requires timestamp-backed or explicitly on-chain freshness metadata for scoring passthrough", async () => {
    const now = 10_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          reserveSyncRow({ last_attempted_at: now, last_success_at: now }),
          reserveSyncRow({
            stablecoin_id: "gho-aave",
            adapter_key: "gho",
            breaker_key: "live-reserves:gho",
            last_attempted_at: now,
            last_success_at: now,
          }),
          reserveSyncRow({
            stablecoin_id: "usds-sky",
            adapter_key: "sky-makercore",
            breaker_key: "live-reserves:sky-makercore",
            last_attempted_at: now,
            last_success_at: now,
          }),
        ],
      },
      {
        match: "reserve_composition",
        rows: [
          reserveCompositionRow({
            slices: JSON.stringify([{ name: "Known Farm", pct: 100, risk: "low" }]),
            fetched_at: now,
            metadata: JSON.stringify({ freshnessMode: "unverified", sourceTimestamp: now }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          }),
          reserveCompositionRow({
            stablecoin_id: "gho-aave",
            slices: JSON.stringify([{ name: "Tracked GSM", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "gho",
            metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          }),
          reserveCompositionRow({
            stablecoin_id: "usds-sky",
            slices: JSON.stringify([{ name: "PSM USDC", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "sky-makercore",
            metadata: JSON.stringify({ sourceTimestamp: now }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          }),
        ],
      },
    ]);

    const scoringMap = await loadFreshIndependentLiveReserveMap(db, now + 100);
    expect(scoringMap.has("iusd-infinifi")).toBe(false);
    expect(scoringMap.get("gho-aave")).toEqual([{ name: "Tracked GSM", pct: 100, risk: "low" }]);
    expect(scoringMap.get("usds-sky")).toEqual([{ name: "PSM USDC", pct: 100, risk: "low" }]);
  });

  it("keeps static-validated, weak-probe, and unverified active configs out of score-grade reserve maps", async () => {
    const now = 10_000;
    const configuredCoins = getConfiguredLiveReserveCoins();
    const coinsWithDefinitions = configuredCoins.map((coin) => {
      const definition = getLiveReserveAdapterDefinition(coin.liveReservesConfig?.adapter ?? "");
      expect(definition, `${coin.id} has a registered live reserve adapter`).not.toBeNull();
      return { coin, definition: definition! };
    });
    const nonScoringEvidenceCoins = coinsWithDefinitions.filter(
      ({ definition }) => definition.evidenceClass === "static-validated"
        || definition.evidenceClass === "weak-live-probe",
    );
    const independentCoins = coinsWithDefinitions.filter(
      ({ definition }) => definition.evidenceClass === "independent",
    );
    const independentVerified = independentCoins[0];
    const independentLatestState = independentCoins.find(
      ({ coin }) => coin.id !== independentVerified?.coin.id,
    );
    const independentUnverified = independentCoins.find(
      ({ coin }) =>
        coin.id !== independentVerified?.coin.id &&
        coin.id !== independentLatestState?.coin.id,
    );

    expect(
      nonScoringEvidenceCoins.some(({ definition }) => definition.evidenceClass === "static-validated"),
      "expected at least one active static-validated config",
    ).toBe(true);
    expect(
      nonScoringEvidenceCoins.some(({ definition }) => definition.evidenceClass === "weak-live-probe"),
      "expected at least one active weak-live-probe config",
    ).toBe(true);
    expect(independentVerified, "expected an active independent config for the verified control").toBeDefined();
    expect(independentLatestState, "expected a second active independent config for the latest-state control").toBeDefined();
    expect(independentUnverified, "expected a third active independent config for the unverified control").toBeDefined();

    const scoringRows = [
      {
        stablecoin_id: independentVerified!.coin.id,
        slices: JSON.stringify([{ name: "Verified independent reserves", pct: 100, risk: "low" }]),
        fetched_at: now,
        source: independentVerified!.coin.liveReservesConfig!.adapter,
        metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: now }),
        adapter_source_model: independentVerified!.definition.sourceModel,
        adapter_evidence_class: independentVerified!.definition.evidenceClass,
      },
      {
        stablecoin_id: independentLatestState!.coin.id,
        slices: JSON.stringify([{ name: "Latest-state reserves", pct: 100, risk: "medium" }]),
        fetched_at: now,
        source: independentLatestState!.coin.liveReservesConfig!.adapter,
        metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
        adapter_source_model: independentLatestState!.definition.sourceModel,
        adapter_evidence_class: independentLatestState!.definition.evidenceClass,
      },
    ];
    const nonScoringRows = [
      ...nonScoringEvidenceCoins.map(({ coin, definition }) => ({
        stablecoin_id: coin.id,
        slices: JSON.stringify([{ name: `${definition.evidenceClass} reserves`, pct: 100, risk: "low" }]),
        fetched_at: now,
        source: coin.liveReservesConfig!.adapter,
        metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: now }),
        adapter_source_model: definition.sourceModel,
        adapter_evidence_class: definition.evidenceClass,
      })),
      {
        stablecoin_id: independentUnverified!.coin.id,
        slices: JSON.stringify([{ name: "Legacy exception reserves", pct: 100, risk: "medium" }]),
        fetched_at: now,
        source: independentUnverified!.coin.liveReservesConfig!.adapter,
        metadata: JSON.stringify({
          freshnessMode: "unverified",
          sourceTimestamp: now,
          scoringAllowsUnverifiedFreshness: true,
        }),
        adapter_source_model: independentUnverified!.definition.sourceModel,
        adapter_evidence_class: independentUnverified!.definition.evidenceClass,
      },
    ];
    const allRows = [...scoringRows, ...nonScoringRows];
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: allRows.map((row) => ({
          stablecoin_id: row.stablecoin_id,
          adapter_key: row.source,
          breaker_key: `live-reserves:${row.source}`,
          last_attempted_at: now,
          last_success_at: now,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        })),
      },
      {
        match: "reserve_composition",
        rows: allRows,
      },
    ]);

    const scoringMap = await loadFreshIndependentLiveReserveMap(db, now + 100);

    expect(scoringMap.get(independentVerified!.coin.id)).toEqual([
      { name: "Verified independent reserves", pct: 100, risk: "low" },
    ]);
    expect(scoringMap.get(independentLatestState!.coin.id)).toEqual([
      { name: "Latest-state reserves", pct: 100, risk: "medium" },
    ]);
    expect(scoringMap.has(independentUnverified!.coin.id)).toBe(false);
    for (const { coin, definition } of nonScoringEvidenceCoins) {
      expect(
        scoringMap.has(coin.id),
        `${coin.id} (${coin.liveReservesConfig!.adapter}/${definition.evidenceClass}) must not be score-grade`,
      ).toBe(false);
    }
  });

  it("rolls up fresh evidence quality and uncertain write states separately", async () => {
    const now = 10_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          reserveSyncRow({ stablecoin_id: "frax-frax", adapter_key: "frax", breaker_key: "live-reserves:frax", last_attempted_at: now, last_success_at: now }),
          reserveSyncRow({ last_attempted_at: now, last_success_at: now }),
          reserveSyncRow({ stablecoin_id: "gho-aave", adapter_key: "gho", breaker_key: "live-reserves:gho", last_attempted_at: now, last_success_at: now }),
          reserveSyncRow({ stablecoin_id: "pyusd-paypal", adapter_key: "single-asset", breaker_key: "live-reserves:single-asset", last_attempted_at: now, last_success_at: now }),
          reserveSyncRow({
            stablecoin_id: "crvusd-curve",
            adapter_key: "crvusd",
            breaker_key: "live-reserves:crvusd",
            last_attempted_at: now,
            last_success_at: null,
            last_status: "error",
            last_error: "D1 write timeout for crvusd-curve",
            metadata: JSON.stringify({ uncertainWrite: true, reason: "storage-write-timeout" }),
          }),
        ],
      },
      {
        match: "reserve_composition",
        rows: [
          reserveCompositionRow({
            stablecoin_id: "frax-frax",
            slices: JSON.stringify([{ name: "Reviewed baseline", pct: 100, risk: "very-low" }]),
            fetched_at: now,
            source: "frax",
            metadata: JSON.stringify({ freshnessMode: "unverified" }),
            adapter_source_model: "validated-static",
            adapter_evidence_class: "static-validated",
          }),
          reserveCompositionRow({
            slices: JSON.stringify([{ name: "Known Farm", pct: 100, risk: "low" }]),
            fetched_at: now,
            metadata: JSON.stringify({ freshnessMode: "unverified" }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          }),
          reserveCompositionRow({
            stablecoin_id: "gho-aave",
            slices: JSON.stringify([{ name: "Tracked GSM", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "gho",
            metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          }),
          reserveCompositionRow({
            stablecoin_id: "pyusd-paypal",
            slices: JSON.stringify([{ name: "Issuer reserves", pct: 100, risk: "very-low" }]),
            fetched_at: now,
            source: "single-asset",
            metadata: JSON.stringify({}),
            adapter_source_model: "single-bucket",
            adapter_evidence_class: "weak-live-probe",
          }),
        ],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now + 100);
    expect(overview.freshCoins).toBeGreaterThanOrEqual(4);
    expect(overview.independentFreshEligible).toBe(1);
    expect(overview.independentFreshUnverified).toBe(1);
    expect(overview.staticValidatedFresh).toBe(1);
    expect(overview.weakProbeFresh).toBe(1);
    expect(overview.writeTimeoutUncertain).toBe(1);
  });

  it("counts an uncertainWrite coin with no composition in a single primary bucket", async () => {
    const now = 10_000;
    const emptyOverview = await computeReserveCompositionOverview(mockD1(), now);
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          {
            stablecoin_id: "crvusd-curve",
            adapter_key: "crvusd",
            breaker_key: "live-reserves:crvusd",
            last_attempted_at: now,
            last_success_at: null,
            last_status: "error",
            warning_count: 0,
            warnings: null,
            last_error: "D1 write timeout",
            metadata: JSON.stringify({ uncertainWrite: true, reason: "storage-write-timeout" }),
          },
        ],
      },
      {
        match: "reserve_composition",
        rows: [],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);

    // Primary bucket increments by exactly 1 (errorCoins, because lastStatus=error + no composition).
    expect(overview.errorCoins).toBe(emptyOverview.errorCoins + 1);
    expect(overview.missingCoins).toBe(emptyOverview.missingCoins - 1);
    expect(overview.writeTimeoutUncertain).toBe(1);

    // Sum of primary buckets equals configured coins (no cross-counting).
    const primarySum = overview.freshCoins
      + overview.staleCoins
      + overview.missingCoins
      + overview.degradedCoins
      + overview.errorCoins
      + overview.corruptCoins;
    expect(primarySum).toBe(overview.configuredCoins);
  });

  it("surfaces partial deferred-tail cursor diagnostics in the overview", async () => {
    const now = 10_000;
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [LIVE_RESERVE_RUN_CURSOR_CACHE_KEY],
        rows: [],
        first: {
          value: JSON.stringify({
            nextStablecoinId: "coin-tail",
            deferredCount: 12,
            deferredAt: 9_900,
            reason: "run-budget-exhausted",
            tailState: "incomplete",
            tailError: "batch unavailable",
            cursorRecordedAt: 9_900,
            tailFailedAt: 9_905,
            runBudgetTruncationCount: 2,
          }),
          updated_at: 9_905,
        },
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);

    expect(overview.runBudgetTruncated).toBe(true);
    expect(overview.deferredCoins).toBeGreaterThanOrEqual(12);
    expect(overview.nextCursorStablecoinId).toBe("coin-tail");
    expect(overview.cursorTailState).toBe("incomplete");
    expect(overview.cursorTailError).toBe("batch unavailable");
    expect(overview.cursorRecordedAt).toBe(9_900);
    expect(overview.cursorTailFailedAt).toBe(9_905);
    expect(overview.cursorTailCompletedAt).toBeNull();
    expect(overview.runBudgetTruncationCount).toBe(2);
  });

  it("detects authoritative reserve snapshots missing history rows", async () => {
    const db = mockD1([
      {
        match: "FROM reserve_composition c",
        rows: [
          {
            stablecoin_id: "coin-a",
            fetched_at: 1_700_000_000,
            attempt_id: "coin-a:attempt",
            composition_history_missing: 1,
            attempt_history_missing: 0,
          },
        ],
      },
    ]);

    await expect(loadLiveReserveHistoryWriteGaps(db)).resolves.toEqual([
      {
        stablecoinId: "coin-a",
        fetchedAt: 1_700_000_000,
        attemptId: "coin-a:attempt",
        compositionHistoryMissing: true,
        attemptHistoryMissing: false,
      },
    ]);
  });

  it("counts malformed stored slices as corruptCoins, not freshCoins", async () => {
    const now = Math.floor(Date.now() / 1000);
    const emptyOverview = await computeReserveCompositionOverview(mockD1(), now);

    // Stored slices array has invalid entries (missing risk, bad pct type) that
    // will fail the LiveReserveSnapshotSchema parse in parseReserveCompositionRow.
    const corruptSlices = [
      { name: "Missing Risk", pct: 20 },
      { name: "Bad Pct", pct: "fifty", risk: "low" },
    ];
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [
          {
            stablecoin_id: "iusd-infinifi",
            slices: JSON.stringify(corruptSlices),
            fetched_at: now,
            source: "infinifi",
            attempt_id: "attempt-1",
            metadata: "{}",
            warning_count: 0,
          },
        ],
      },
      {
        match: "reserve_sync_state",
        rows: [
          {
            stablecoin_id: "iusd-infinifi",
            adapter_key: "infinifi",
            breaker_key: "live-reserves:infinifi",
            last_attempted_at: now,
            last_success_at: now,
            last_status: "ok",
            warning_count: 0,
            warnings: null,
            last_error: null,
            metadata: "{}",
            last_attempt_id: "attempt-1",
            pending_attempt_id: null,
            last_success_attempt_id: "attempt-1",
          },
        ],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);
    expect(overview.corruptCoins).toBe(emptyOverview.corruptCoins + 1);
    // Corrupt snapshot must not be counted as fresh even though the sync state
    // reports lastStatus=ok and age=0.
    expect(overview.freshCoins).toBe(emptyOverview.freshCoins);
  });

  it("flags independent-class coins whose source has been degraded/error for >14d as persistently stale", async () => {
    const now = Math.floor(Date.now() / 1000);
    const FIFTEEN_DAYS = 15 * 86_400;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow({
          last_attempted_at: now,
          last_success_at: now - FIFTEEN_DAYS,
          last_status: "degraded",
          warning_count: 1,
        })],
      },
      {
        match: "reserve_composition",
        rows: [],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);

    const entry = overview.persistentlyStaleIndependentCoins.find(
      (e) => e.stablecoinId === "iusd-infinifi",
    );
    expect(entry).toBeDefined();
    expect(entry!.ageSec).toBeGreaterThanOrEqual(FIFTEEN_DAYS);
  });

  it("flags old circuit-open independent feeds as persistently stale", async () => {
    const now = Math.floor(Date.now() / 1000);
    const FIFTEEN_DAYS = 15 * 86_400;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow({
          last_attempted_at: now,
          last_success_at: now - FIFTEEN_DAYS,
          last_status: "skipped",
          last_error: "Circuit open for live-reserves:infinifi",
          metadata: JSON.stringify({ failureCategory: "circuit-open" }),
        })],
      },
      {
        match: "reserve_composition",
        rows: [],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);

    const entry = overview.persistentlyStaleIndependentCoins.find(
      (e) => e.stablecoinId === "iusd-infinifi",
    );
    expect(entry).toBeDefined();
    expect(entry!.ageSec).toBeGreaterThanOrEqual(FIFTEEN_DAYS);
  });

  it("does not flag old run-budget deferred rows as persistently stale", async () => {
    const now = Math.floor(Date.now() / 1000);
    const FIFTEEN_DAYS = 15 * 86_400;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow({
          last_attempted_at: now,
          last_success_at: now - FIFTEEN_DAYS,
          last_status: "skipped",
          last_error: "run-budget-exhausted",
          metadata: JSON.stringify({ failureCategory: "run-budget-exhausted" }),
        })],
      },
      {
        match: "reserve_composition",
        rows: [],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);

    expect(
      overview.persistentlyStaleIndependentCoins.find(
        (e) => e.stablecoinId === "iusd-infinifi",
      ),
    ).toBeUndefined();
  });

  it("does not flag independent coins whose last success is within the 14d threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    const THIRTEEN_DAYS = 13 * 86_400;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow({
          last_attempted_at: now,
          last_success_at: now - THIRTEEN_DAYS,
          last_status: "degraded",
          warning_count: 1,
        })],
      },
      {
        match: "reserve_composition",
        rows: [],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);

    expect(
      overview.persistentlyStaleIndependentCoins.find(
        (e) => e.stablecoinId === "iusd-infinifi",
      ),
    ).toBeUndefined();
  });

  it("does not flag independent coins with an ok sync status even when old", async () => {
    const now = Math.floor(Date.now() / 1000);
    const TWENTY_DAYS = 20 * 86_400;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow({
          last_attempted_at: now,
          last_success_at: now - TWENTY_DAYS,
        })],
      },
      {
        match: "reserve_composition",
        rows: [],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);

    expect(
      overview.persistentlyStaleIndependentCoins.find(
        (e) => e.stablecoinId === "iusd-infinifi",
      ),
    ).toBeUndefined();
  });
});
