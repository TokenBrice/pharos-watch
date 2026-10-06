import { describe, expect, it } from "vitest";
import { ApiFetchError } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type {
  ReservePresentationMode,
  ReserveProvenanceView,
  ReserveSyncStateView,
  ReserveDisplayBadgeView,
} from "@shared/types";
import {
  buildReserveFetchNotice,
  buildReserveFootnoteModel,
  buildReserveCompositionNote,
  buildReserveProvenanceNotice,
  buildReserveFeedStatus,
  buildReserveSourceChip,
  liveCompositionDiffers,
  reserveSliceLabel,
  type ReserveCompositionSlice,
  formatReserveSnapshotLabel,
} from "../reserve-presentation";

// Notices carry only a tone: neutral is informational, watch is an active
// (amber) condition. Nothing in the reserve module is red.
const AMBER = "watch";
const NEUTRAL = "neutral";

function makeReserves(overrides: Partial<ReserveResult> & { mode: ReservePresentationMode }): ReserveResult {
  return {
    reserves: [{ name: "Cash & Bank Deposits", pct: 100, risk: "very-low" }],
    estimated: false,
    ...overrides,
  };
}

function makeProvenance(overrides: Partial<ReserveProvenanceView> = {}): ReserveProvenanceView {
  return {
    evidenceClass: "independent",
    sourceModel: "dynamic-mix",
    scoringEligible: true,
    ...overrides,
  };
}

function networkError(): TypeError {
  return new TypeError("Failed to fetch");
}

describe("buildReserveFetchNotice", () => {
  it("live-stale → amber refresh-delayed tone", () => {
    const notice = buildReserveFetchNotice(new Error("boom"), makeReserves({ mode: "live-stale" }));
    expect(notice.title).toBe("Live reserve refresh delayed");
    expect(notice.tone).toBe(AMBER);
  });

  it("live → amber refresh-delayed tone", () => {
    const notice = buildReserveFetchNotice(new Error("boom"), makeReserves({ mode: "live" }));
    expect(notice.title).toBe("Live reserve refresh delayed");
    expect(notice.tone).toBe(AMBER);
  });

  it("curated-fallback → amber, curated baseline message", () => {
    const notice = buildReserveFetchNotice(new Error("boom"), makeReserves({ mode: "curated-fallback" }));
    expect(notice.title).toBe("Live reserve feed unavailable");
    expect(notice.message).toContain("curated reserve baseline");
    expect(notice.tone).toBe(AMBER);
  });

  it("template-fallback → amber, estimated template message", () => {
    const notice = buildReserveFetchNotice(new Error("boom"), makeReserves({ mode: "template-fallback" }));
    expect(notice.title).toBe("Live reserve feed unavailable");
    expect(notice.message).toContain("estimated reserve template");
    expect(notice.tone).toBe(AMBER);
  });

  it("503 ApiFetchError with no fallback → neutral 'not yet available' (not amber)", () => {
    const notice = buildReserveFetchNotice(new ApiFetchError("/r", 503, null), null);
    expect(notice.title).toBe("Live reserve data not yet available");
    expect(notice.message).toContain("check back shortly");
    expect(notice.tone).toBe(NEUTRAL);
  });

  it("503 ApiFetchError with fallback view → neutral, fallback message", () => {
    const notice = buildReserveFetchNotice(new ApiFetchError("/r", 503, null), makeReserves({ mode: "unavailable" }));
    expect(notice.title).toBe("Live reserve data not yet available");
    expect(notice.message).toContain("current fallback view");
    expect(notice.tone).toBe(NEUTRAL);
  });

  it("network error with no fallback → connection issue asking the reader to retry", () => {
    const notice = buildReserveFetchNotice(networkError(), null);
    expect(notice.title).toBe("Connection issue");
    expect(notice.message).toContain("check your connection");
    expect(notice.tone).toBe(AMBER);
  });

  it("network error with fallback view → amber connection issue", () => {
    const notice = buildReserveFetchNotice(networkError(), makeReserves({ mode: "unavailable" }));
    expect(notice.title).toBe("Connection issue");
    expect(notice.message).toContain("current fallback view");
    expect(notice.tone).toBe(AMBER);
  });

  it("generic error with no fallback → generic message, never the raw error text", () => {
    const notice = buildReserveFetchNotice(new Error("upstream exploded"), null);
    expect(notice.title).toBe("Live reserve feed unavailable");
    expect(notice.message).toBe("Unable to load reserve composition right now.");
    expect(notice.tone).toBe(AMBER);
  });

  it("generic non-Error with no fallback → generic message", () => {
    const notice = buildReserveFetchNotice("string failure", null);
    expect(notice.message).toBe("Unable to load reserve composition right now.");
    expect(notice.tone).toBe(AMBER);
  });

  it("generic error with fallback view → amber, fallback message", () => {
    const notice = buildReserveFetchNotice(new Error("upstream exploded"), makeReserves({ mode: "unavailable" }));
    expect(notice.title).toBe("Live reserve feed unavailable");
    expect(notice.message).toContain("current fallback view");
    expect(notice.tone).toBe(AMBER);
  });

  it("mode precedence: live-stale wins even over a 503 error", () => {
    const notice = buildReserveFetchNotice(new ApiFetchError("/r", 503, null), makeReserves({ mode: "live-stale" }));
    expect(notice.title).toBe("Live reserve refresh delayed");
  });
});

describe("buildReserveFootnoteModel", () => {
  it("live → fresh label, includes source + evidence references", () => {
    const result = buildReserveFootnoteModel(
      makeReserves({ mode: "live", liveAt: 1_700_000_000, displayUrl: "https://src", evidenceUrls: ["https://e1", "https://e2"] }),
      true,
      "rwa backed",
    );
    expect(result?.text).toContain("Checked");
    expect(result?.references).toEqual([
      { label: "Source", url: "https://src" },
      { label: "Evidence", url: "https://e1" },
      { label: "Evidence 2", url: "https://e2" },
    ]);
  });

  it("live with curated-validated badge → curated-validated label", () => {
    const badge: ReserveDisplayBadgeView = { kind: "curated-validated", label: "Curated" };
    const result = buildReserveFootnoteModel(
      makeReserves({ mode: "live", liveAt: 1_700_000_000, displayBadge: badge }),
      true,
      "rwa backed",
    );
    expect(result?.text).toContain("Source date unavailable · Checked");
  });

  it("live-stale → stale label", () => {
    const result = buildReserveFootnoteModel(
      makeReserves({ mode: "live-stale", liveAt: 1_700_000_000 }),
      true,
      "rwa backed",
    );
    expect(result?.text).toContain("Stale · Checked");
  });

  it("curated-fallback with live enabled → live-sync-unavailable text, no references", () => {
    const result = buildReserveFootnoteModel(
      makeReserves({ mode: "curated-fallback", displayUrl: "https://src" }),
      true,
      "rwa backed",
    );
    expect(result?.text).toBe("Live sync unavailable; showing curated reserve baseline");
    expect(result?.references).toEqual([]);
  });

  it("curated-fallback with live disabled → null", () => {
    expect(
      buildReserveFootnoteModel(makeReserves({ mode: "curated-fallback" }), false, "rwa backed"),
    ).toBeNull();
  });

  it("template-fallback with live disabled + estimated → classification text", () => {
    const result = buildReserveFootnoteModel(
      makeReserves({ mode: "template-fallback", estimated: true }),
      false,
      "rwa backed",
    );
    expect(result?.text).toBe("Estimated composition based on rwa backed classification");
  });

  it("template-fallback with live disabled + not estimated → null", () => {
    expect(
      buildReserveFootnoteModel(makeReserves({ mode: "template-fallback", estimated: false }), false, "rwa backed"),
    ).toBeNull();
  });

  it("unavailable → composition-unavailable text", () => {
    const result = buildReserveFootnoteModel(makeReserves({ mode: "unavailable" }), true, "rwa backed");
    expect(result?.text).toBe("Reserve composition unavailable");
  });
});

describe("buildReserveCompositionNote", () => {
  it("discloses only explicitly scoped live evidence, never retained unmarked or curated fallback evidence", () => {
    const metadata = {
      balanceSheetScope: "shared-sky-maker" as const,
      sharedBookAssetIds: ["dai-makerdao", "usds-sky"],
    };
    expect(buildReserveCompositionNote(makeReserves({ mode: "live-stale", metadata }))).toMatch(/shared Sky\/Maker/);
    expect(buildReserveCompositionNote(makeReserves({ mode: "live-stale", metadata: {} }))).toBeNull();
    expect(buildReserveCompositionNote(makeReserves({ mode: "curated-fallback", metadata }))).toBeNull();
  });

  it("returns null when not a live mode", () => {
    expect(
      buildReserveCompositionNote(makeReserves({ mode: "curated-fallback", metadata: { yieldBasisCollateralPct: 25 } })),
    ).toBeNull();
  });

  it("returns null when no positive yield-basis share", () => {
    expect(buildReserveCompositionNote(makeReserves({ mode: "live", metadata: { yieldBasisCollateralPct: 0 } }))).toBeNull();
    expect(buildReserveCompositionNote(makeReserves({ mode: "live" }))).toBeNull();
  });

  it("formats the yield-basis share for live reserves", () => {
    const note = buildReserveCompositionNote(
      makeReserves({ mode: "live", metadata: { yieldBasisCollateralPct: 33.456 } }),
    );
    expect(note).toBe("Yield Basis positions account for 33.5% of this live reserve mix.");
  });

  it("formats strategy reference NAV for live reserves", () => {
    const note = buildReserveCompositionNote(
      makeReserves({ mode: "live", metadata: { referenceNavUsd: 1.034963 } }),
    );
    expect(note).toBe("Strategy reference NAV is $1.0350 per share.");
  });

  it("combines reference NAV with existing composition notes", () => {
    const note = buildReserveCompositionNote(
      makeReserves({ mode: "live", metadata: { referenceNavUsd: 1.034963, yieldBasisCollateralPct: 33.456 } }),
    );
    expect(note).toBe(
      "Strategy reference NAV is $1.0350 per share. Yield Basis positions account for 33.5% of this live reserve mix.",
    );
  });
});

describe("buildReserveProvenanceNotice", () => {
  it("returns null without provenance or live mode", () => {
    expect(buildReserveProvenanceNotice(makeReserves({ mode: "live" }))).toBeNull();
    expect(
      buildReserveProvenanceNotice(makeReserves({ mode: "curated-fallback", provenance: makeProvenance() })),
    ).toBeNull();
  });

  it("curated-validated badge takes precedence", () => {
    const notice = buildReserveProvenanceNotice(
      makeReserves({
        mode: "live",
        provenance: makeProvenance(),
        displayBadge: { kind: "curated-validated", label: "Curated" },
      }),
    );
    expect(notice?.title).toBe("Curated-validated reserve baseline");
    expect(notice?.tone).toBe("neutral");
  });

  it("proof badge outranks an independent provenance class", () => {
    const notice = buildReserveProvenanceNotice(
      makeReserves({
        mode: "live",
        provenance: makeProvenance({ evidenceClass: "independent", scoringEligible: true }),
        displayBadge: { kind: "proof", label: "Proof" },
      }),
    );
    // A dated proof must never be presented as an independent live feed.
    expect(notice?.title).toBe("Reserve evidence");
    expect(notice?.message).toContain("does not advance the underlying evidence date");
  });

  it("independent + scoring-eligible → independent disclosure", () => {
    const notice = buildReserveProvenanceNotice(
      makeReserves({ mode: "live", provenance: makeProvenance({ evidenceClass: "independent", scoringEligible: true }) }),
    );
    expect(notice?.title).toBe("Independent live reserve disclosure");
    expect(notice?.message).toContain("independently measured");
  });

  it("independent + not scoring-eligible + unverified freshness → freshness caveat", () => {
    const notice = buildReserveProvenanceNotice(
      makeReserves({
        mode: "live",
        provenance: makeProvenance({ scoringEligible: false, freshnessMode: "unverified" }),
      }),
    );
    expect(notice?.message).toContain("freshness is not verified strongly enough");
  });

  it("static-validated → live disclosure (not independent)", () => {
    const notice = buildReserveProvenanceNotice(
      makeReserves({ mode: "live", provenance: makeProvenance({ evidenceClass: "static-validated" }) }),
    );
    expect(notice?.title).toBe("Live reserve disclosure");
  });

  it("weak-live-probe → proof-based view", () => {
    const notice = buildReserveProvenanceNotice(
      makeReserves({ mode: "live", provenance: makeProvenance({ evidenceClass: "weak-live-probe" }) }),
    );
    expect(notice?.title).toBe("Proof-based reserve view");
  });
});

describe("buildReserveFeedStatus", () => {
  function makeSync(overrides: Partial<ReserveSyncStateView> = {}): ReserveSyncStateView {
    return {
      enabled: true,
      status: "ok",
      stale: false,
      bootstrap: false,
      ...overrides,
    };
  }

  it("returns null for healthy ok sync without uncertain write", () => {
    expect(buildReserveFeedStatus(makeReserves({ mode: "live", sync: makeSync() }), null)).toBeNull();
    expect(buildReserveFeedStatus(makeReserves({ mode: "live" }), null)).toBeNull();
    expect(buildReserveFeedStatus(null, null)).toBeNull();
  });

  it("ok status with uncertain write → degraded chip (partial data)", () => {
    const status = buildReserveFeedStatus(
      makeReserves({ mode: "live", sync: makeSync({ status: "ok", uncertainWrite: true }) }),
      null,
    );
    expect(status?.label).toBe("Reserve sync degraded · uncertain-write");
    expect(status?.rows).toContain("Sync status: ok");
    expect(status?.rows).toContain("Latest write state uncertain");
    expect(status?.tone).toBe("watch");
  });

  it("error status with full failure detail → amber chip carrying the failure category", () => {
    const status = buildReserveFeedStatus(
      makeReserves({
        mode: "live",
        sync: makeSync({ status: "error", failureCategory: "upstream", lastError: "503 from adapter", uncertainWrite: true }),
      }),
      null,
    );
    expect(status?.label).toBe("Reserve sync error · upstream");
    expect(status?.reason).toBe("upstream");
    expect(status?.rows).toEqual([
      "Reason: upstream",
      "Sync status: error",
      "Last error: 503 from adapter",
      "Latest write state uncertain",
    ]);
    expect(status?.tone).toBe("watch");
  });

  it("degraded status → amber degraded chip", () => {
    const status = buildReserveFeedStatus(makeReserves({
      mode: "curated-fallback",
      sync: makeSync({
        status: "degraded",
        warnings: ["Upstream reserve source timestamp exceeds the accepted age"],
      }),
    }), null);
    expect(status?.label).toBe("Reserve sync degraded · warnings");
    expect(status?.rows).toContain("Upstream reserve source timestamp exceeds the accepted age");
    expect(status?.tone).toBe("watch");
  });

  it("a validation error that only reports source age becomes a stale chip naming date and budget in days", () => {
    const status = buildReserveFeedStatus(
      makeReserves({
        mode: "live-stale",
        liveAt: Date.parse("2026-10-04T12:00:00Z") / 1000,
        metadata: { sourceTimestamp: Date.parse("2026-09-24T00:00:00Z") / 1000 },
        sync: makeSync({
          status: "error",
          stale: true,
          failureCategory: "validation",
          lastError: "Validation failed: Redemption source timestamp is 1066290s old for dynamic-mix/independent (max 604800s)",
          warnings: ["Redemption source timestamp is 1066290s old for dynamic-mix/independent (max 604800s)"],
        }),
      }),
      null,
    );
    expect(status?.label).toBe("Reserve feed stale · last report 24 Sep · 7-day budget");
    expect(status?.reason).toBe("source-age");
    expect(status?.tone).toBe("watch");
    const detail = status?.rows.join(" ") ?? "";
    expect(detail).toContain("Source age: 12.3 days (budget 7 days)");
    expect(detail).not.toMatch(/1066290|604800|Validation failed/);
  });

  it("prefers the published freshness verdict over parsing the warning text", () => {
    const status = buildReserveFeedStatus(
      makeReserves({
        mode: "live-stale",
        sync: makeSync({
          status: "degraded",
          stale: true,
          warnings: ["Upstream reserve source timestamp is 700000s old for static-validated (max 604800s)"],
          freshness: {
            stale: true, staleReasons: ["source-age"], assessedAt: 1_790_000_000, fetchedAt: 1_789_900_000,
            attemptId: null, fetchAgeSec: 100_000, fetchBudgetSec: 172_800,
            sourceTimestamp: Date.parse("2026-09-20T00:00:00Z") / 1000, sourceAgeSec: 691_200,
            sourceAgeBudgetSec: 345_600, sourceAgeBudgetCap: "adapter",
          },
        }),
      }),
      null,
    );
    expect(status?.label).toBe("Reserve feed stale · last report 20 Sep · 4-day budget");
  });

  it("never-attempted live adapter → neutral pending chip, not degraded", () => {
    const pending = makeReserves({
      mode: "curated-fallback",
      sync: makeSync({ status: "skipped", bootstrap: true }),
    });
    const status = buildReserveFeedStatus(pending, null);
    expect(status?.label).toBe("Live sync pending first run");
    expect(status?.tone).toBe("neutral");
    expect(status?.reason).toBe("bootstrap-pending");
    expect(buildReserveFootnoteModel(pending, true, "rwa backed")?.text)
      .toBe("Live sync pending first run; showing curated reserve baseline");
  });

  it.each([
    { lastAttemptedAt: 1_700_000_000 },
    { lastError: "run-budget-exhausted" },
    { failureCategory: "circuit-open" },
    { warnings: ["Adapter returned a partial slice set"] },
  ])("skipped bootstrap with attempt or failure evidence %o stays degraded", (evidence) => {
    const reserves = makeReserves({
      mode: "curated-fallback",
      sync: makeSync({ status: "skipped", bootstrap: true, ...evidence }),
    });
    expect(buildReserveFeedStatus(reserves, null)?.label).toContain("Reserve sync degraded");
    expect(buildReserveFootnoteModel(reserves, true, "rwa backed")?.text)
      .toBe("Live sync unavailable; showing curated reserve baseline");
  });

  it("a failed fetch outranks the sync state and stays retryable with a machine-readable reason", () => {
    const status = buildReserveFeedStatus(
      makeReserves({ mode: "live", sync: makeSync({ status: "degraded", warnings: ["Adapter returned a partial slice set"] }) }),
      new Error("boom"),
    );
    expect(status?.label).toBe("Live reserve refresh delayed");
    expect(status?.reason).toBe("fetch-failed");
    expect(status?.retryable).toBe(true);
    expect(status?.rows).toContain("Adapter returned a partial slice set");
    expect(buildReserveFeedStatus(null, new ApiFetchError("/r", 503, null))?.reason).toBe("api-unavailable");
    expect(buildReserveFeedStatus(null, networkError())?.reason).toBe("network");
  });
});

describe("reserve source chip", () => {
  it("uses the adapter badge label, upgrading a weak live probe to Live proof", () => {
    const badge: ReserveDisplayBadgeView = { kind: "proof", label: "Proof" };
    expect(buildReserveSourceChip(makeReserves({
      mode: "live", displayBadge: badge, provenance: makeProvenance({ evidenceClass: "independent" }),
    }))?.label).toBe("Proof");
    expect(buildReserveSourceChip(makeReserves({
      mode: "live", displayBadge: badge, provenance: makeProvenance({ evidenceClass: "weak-live-probe" }),
    }))?.label).toBe("Live proof");
    expect(buildReserveSourceChip(makeReserves({ mode: "curated-fallback" }))).toBeNull();
  });

  it("carries the dated-evidence sentence as the tooltip, not as page copy", () => {
    const chip = buildReserveSourceChip(makeReserves({
      mode: "live", displayBadge: { kind: "proof", label: "Attestation" }, provenance: makeProvenance(),
    }));
    expect(chip?.label).toBe("Attestation");
    expect(chip?.tooltip).toContain("dated attestation, proof, or liveness check");
  });
});

describe("reserve composition slices", () => {
  it("keeps contract identifiers off the visual, preferring the reviewed obligor", () => {
    expect(reserveSliceLabel("GhoDirectFacilitator GSM Arbitrum", "Aave DAO Arbitrum GHO Reserve and remote GSM"))
      .toBe("Aave DAO Arbitrum GHO Reserve and remote GSM");
    expect(reserveSliceLabel("CoreGhoDirectMinter", null)).toBe("Core Gho Direct Minter");
    expect(reserveSliceLabel("stataUSDT GSM", "Tether and Aave GHO Stability Module")).toBe("stataUSDT GSM");
  });

  it("leaves human names alone, including parenthetical expansions", () => {
    expect(reserveSliceLabel("cbBTC (Coinbase Wrapped BTC)", "Coinbase")).toBe("cbBTC (Coinbase Wrapped BTC)");
    expect(reserveSliceLabel("U.S. Treasury bills", "United States Treasury")).toBe("U.S. Treasury bills");
    expect(reserveSliceLabel("USDe staking vault shares", "Ethena")).toBe("USDe staking vault shares");
  });

  it("treats the live feed as the same composition within half a point per rank", () => {
    const slice = (pct: number): ReserveCompositionSlice => ({ key: String(pct), label: "x", pct, risk: "low", detail: null });
    expect(liveCompositionDiffers([slice(60), slice(40)], [slice(59.7), slice(40.3)])).toBe(false);
    expect(liveCompositionDiffers([slice(60), slice(40)], [slice(67.6), slice(32.4)])).toBe(true);
    expect(liveCompositionDiffers([slice(100)], [slice(60), slice(40)])).toBe(true);
  });
});


describe("dated reserve disclosures", () => {
  it.each(["live", "live-stale"] as const)("keeps reviewed composition separate from totals and source-age clocks in %s mode", (mode) => {
    const reserves = makeReserves({
      mode,
      liveAt: Date.parse("2026-09-27T12:14:32Z") / 1000,
      metadata: {
        sourceTimestamp: Date.parse("2026-09-26T00:00:00Z") / 1000,
        details: { compositionSource: "reviewed-config", compositionAsOf: "2026-06-30" },
      },
      sync: {
        enabled: true, status: "degraded", stale: true, bootstrap: false,
        warnings: ["Upstream reserve source timestamp is 700000s old for static-validated (max 604800s)"],
      },
    });
    const stale = mode === "live-stale" ? " · Stale" : "";
    const composition = buildReserveFootnoteModel(reserves, true, "rwa backed")?.text;
    expect(composition).toContain(`Composition as of 2026-06-30${stale} · Checked Sep 27`);
    expect(composition).not.toContain("Sep 26");
    const totals = formatReserveSnapshotLabel(reserves);
    expect(totals).toContain(`Source as of Sep 26, 2026${stale} · Checked Sep 27`);
    expect(totals).not.toContain("2026-06-30");
    const ageStatus = buildReserveFeedStatus(reserves, null);
    expect(ageStatus?.rows).toContain(totals);
    expect(ageStatus?.rows.join(" ")).not.toContain("2026-06-30");
  });

  it.each(["live", "live-stale"] as const)("withholds an undated XAUT reviewed-config composition clock in %s mode", (mode) => {
    const reserves = makeReserves({
      mode,
      liveAt: Date.parse("2026-09-27T12:14:32Z") / 1000,
      metadata: {
        sourceTimestamp: Date.parse("2026-09-26T00:00:00Z") / 1000,
        details: { compositionSource: "reviewed-config" },
      },
    });
    const stale = mode === "live-stale" ? " · Stale" : "";
    expect(buildReserveFootnoteModel(reserves, true, "commodity backed")?.text)
      .toContain(`Composition date unavailable${stale} · Checked Sep 27`);
    expect(formatReserveSnapshotLabel(reserves)).toContain("Source as of Sep 26, 2026");
  });

  it.each(["live", "live-stale"] as const)("withholds retained legacy Tether composition dates without new metadata in %s mode", (mode) => {
    const reserves = makeReserves({
      mode,
      source: "tether-transparency",
      liveAt: Date.parse("2026-09-27T12:14:32Z") / 1000,
      metadata: { sourceTimestamp: Date.parse("2026-09-26T00:00:00Z") / 1000 },
    });
    const stale = mode === "live-stale" ? " · Stale" : "";
    expect(buildReserveFootnoteModel(reserves, true, "rwa backed")?.text)
      .toContain(`Composition date unavailable${stale} · Checked Sep 27`);
    expect(formatReserveSnapshotLabel(reserves)).toContain("Source as of Sep 26, 2026");
  });

  it.each(["2026-02-30", "2026-13-01", "2026-6-30", "2026-06-30T00:00:00Z", "", 20260630])(
    "rejects invalid reviewed composition date %s without borrowing the totals clock",
    (compositionAsOf) => {
      const reserves = makeReserves({
        mode: "live",
        metadata: {
          sourceTimestamp: Date.parse("2026-09-26T00:00:00Z") / 1000,
          details: { compositionSource: "reviewed-config", compositionAsOf },
        },
      });
      expect(buildReserveFootnoteModel(reserves, true, "rwa backed")?.text)
        .toContain("Composition date unavailable · Checked");
    },
  );

  it("separates old report evidence from successful collection", () => {
    const reserves = makeReserves({
      mode: "live-stale", liveAt: Date.parse("2026-09-05T12:14:32Z") / 1000,
      metadata: { sourceTimestamp: Date.parse("2026-06-30T15:59:00Z") / 1000,
        details: { assurance: { reportDate: "2026-06-30" } } },
      sync: { enabled: true, status: "degraded", stale: true, bootstrap: false,
        warnings: ["Upstream reserve source timestamp is 5775332s old for dynamic-mix/independent (max 4000000s)"] },
    });
    const footnote = buildReserveFootnoteModel(reserves, true, "rwa backed");
    expect(footnote?.text).toContain("Report as of 2026-06-30 · Stale · Checked");
    const status = buildReserveFeedStatus(reserves, null);
    expect(status?.label).toBe("Reserve feed stale · last report 30 Jun · 46.3-day budget");
    expect(status?.reason).toBe("source-age");
    expect(status?.rows.join(" ")).not.toContain("5775332");
    expect(buildReserveFeedStatus({ ...reserves, sync: { ...reserves.sync!, status: "error", lastError: "HTTP 503" } }, null)?.label)
      .toBe("Reserve sync error · unclassified");
  });

  it("prefers the report date over the source timestamp", () => {
    const label = buildReserveFootnoteModel(
      makeReserves({
        mode: "live",
        liveAt: Date.parse("2026-09-05T12:14:32Z") / 1000,
        metadata: {
          sourceTimestamp: Date.parse("2026-08-31T00:00:00Z") / 1000,
          details: { assurance: { reportDate: "2026-06-30" } },
        },
      }),
      true,
      "rwa backed",
    )?.text;
    expect(label).toContain("Report as of 2026-06-30");
    expect(label).not.toContain("Source as of");
    expect(label).not.toContain("2026-08-31");
  });

  it("falls back to the source date when no report date is attested", () => {
    const label = buildReserveFootnoteModel(
      makeReserves({
        mode: "live",
        liveAt: Date.parse("2026-09-05T12:14:32Z") / 1000,
        metadata: { sourceTimestamp: Date.parse("2026-06-30T15:59:00Z") / 1000 },
      }),
      true,
      "rwa backed",
    )?.text;
    expect(label).toMatch(/^Source as of \w+ 30, 2026 · Checked /);
    expect(label).not.toContain("Report as of");
    expect(label).not.toContain("Source date unavailable");
  });

  it("keeps operational diagnostics when age is not the only warning", () => {
    const status = buildReserveFeedStatus(
      makeReserves({
        mode: "live-stale",
        sync: {
          enabled: true, status: "degraded", stale: true, bootstrap: false,
          warnings: [
            "Upstream reserve source timestamp is 5775332s old for dynamic-mix/independent (max 4000000s)",
            "Adapter returned a partial slice set",
          ],
        },
      }),
      null,
    );
    expect(status?.label).toBe("Reserve sync degraded · warnings");
    expect(status?.rows).toContain("Adapter returned a partial slice set");
    expect(status?.rows).toContain("Sync status: degraded");
  });

  it.each([
    ["an uncertain write", { uncertainWrite: true } as const],
    ["a recorded last error", { lastError: "HTTP 503" } as const],
  ])("stays a sync-degraded chip when a stale-age warning arrives with %s", (_label, extra) => {
    const status = buildReserveFeedStatus(
      makeReserves({
        mode: "live-stale",
        sync: {
          enabled: true, status: "degraded", stale: true, bootstrap: false,
          warnings: ["Upstream reserve source timestamp is 5775332s old for dynamic-mix/independent (max 4000000s)"],
          ...extra,
        },
      }),
      null,
    );
    expect(status?.reason).not.toBe("source-age");
    expect(status?.label).toContain("Reserve sync degraded");
    // Ages in a diagnostic read in days, never raw seconds.
    expect(status?.rows.join(" ")).toContain("66.8 days old");
    expect(status?.rows.join(" ")).not.toContain("5775332");
  });
});
