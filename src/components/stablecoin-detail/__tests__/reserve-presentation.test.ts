import { describe, expect, it } from "vitest";
import { ApiFetchError } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type {
  ReservePresentationMode,
  ReserveProvenanceView,
  ReserveSyncStateView,
  ReserveDisplayBadgeView,
} from "@shared/types";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import {
  buildReserveFetchNotice,
  buildReserveFootnoteModel,
  buildReserveCompositionNote,
  buildReserveProvenanceNotice,
  buildReserveSyncNotice,
} from "../reserve-presentation";

// Reserve notices carry the shared severity tones (WS8.4); the provenance
// notice already used the house neutral spelling, and the fetch notices were
// migrated onto it from a one-off `bg-muted/40`.
const AMBER = SEVERITY_TONE_CLASS.watch.pill;
const NEUTRAL = SEVERITY_TONE_CLASS.neutral.pill;
const NEUTRAL_PROVENANCE = SEVERITY_TONE_CLASS.neutral.pill;
const DESTRUCTIVE = "border-destructive/50 bg-destructive/10 text-destructive";

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
    expect(notice.toneClass).toBe(AMBER);
  });

  it("live → amber refresh-delayed tone", () => {
    const notice = buildReserveFetchNotice(new Error("boom"), makeReserves({ mode: "live" }));
    expect(notice.title).toBe("Live reserve refresh delayed");
    expect(notice.toneClass).toBe(AMBER);
  });

  it("curated-fallback → amber, curated baseline message", () => {
    const notice = buildReserveFetchNotice(new Error("boom"), makeReserves({ mode: "curated-fallback" }));
    expect(notice.title).toBe("Live reserve feed unavailable");
    expect(notice.message).toContain("curated reserve baseline");
    expect(notice.toneClass).toBe(AMBER);
  });

  it("template-fallback → amber, estimated template message", () => {
    const notice = buildReserveFetchNotice(new Error("boom"), makeReserves({ mode: "template-fallback" }));
    expect(notice.title).toBe("Live reserve feed unavailable");
    expect(notice.message).toContain("estimated reserve template");
    expect(notice.toneClass).toBe(AMBER);
  });

  it("503 ApiFetchError with no fallback → neutral 'not yet available' (not amber)", () => {
    const notice = buildReserveFetchNotice(new ApiFetchError("/r", 503, null), null);
    expect(notice.title).toBe("Live reserve data not yet available");
    expect(notice.message).toContain("check back shortly");
    expect(notice.toneClass).toBe(NEUTRAL);
  });

  it("503 ApiFetchError with fallback view → neutral, fallback message", () => {
    const notice = buildReserveFetchNotice(new ApiFetchError("/r", 503, null), makeReserves({ mode: "unavailable" }));
    expect(notice.title).toBe("Live reserve data not yet available");
    expect(notice.message).toContain("current fallback view");
    expect(notice.toneClass).toBe(NEUTRAL);
  });

  it("network error with no fallback → destructive connection issue", () => {
    const notice = buildReserveFetchNotice(networkError(), null);
    expect(notice.title).toBe("Connection issue");
    expect(notice.message).toContain("check your connection");
    expect(notice.toneClass).toBe(DESTRUCTIVE);
  });

  it("network error with fallback view → amber connection issue", () => {
    const notice = buildReserveFetchNotice(networkError(), makeReserves({ mode: "unavailable" }));
    expect(notice.title).toBe("Connection issue");
    expect(notice.message).toContain("current fallback view");
    expect(notice.toneClass).toBe(AMBER);
  });

  it("generic error with no fallback → destructive, surfaces error message", () => {
    const notice = buildReserveFetchNotice(new Error("upstream exploded"), null);
    expect(notice.title).toBe("Live reserve feed unavailable");
    expect(notice.message).toBe("upstream exploded");
    expect(notice.toneClass).toBe(DESTRUCTIVE);
  });

  it("generic non-Error with no fallback → destructive, generic message", () => {
    const notice = buildReserveFetchNotice("string failure", null);
    expect(notice.message).toBe("Unable to load reserve composition right now.");
    expect(notice.toneClass).toBe(DESTRUCTIVE);
  });

  it("generic error with fallback view → amber, fallback message", () => {
    const notice = buildReserveFetchNotice(new Error("upstream exploded"), makeReserves({ mode: "unavailable" }));
    expect(notice.title).toBe("Live reserve feed unavailable");
    expect(notice.message).toContain("current fallback view");
    expect(notice.toneClass).toBe(AMBER);
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
    expect(result?.text).toContain("Updated");
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
    expect(result?.text).toContain("Curated-validated as of");
  });

  it("live-stale → stale label", () => {
    const result = buildReserveFootnoteModel(
      makeReserves({ mode: "live-stale", liveAt: 1_700_000_000 }),
      true,
      "rwa backed",
    );
    expect(result?.text).toContain("Live snapshot stale");
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
    expect(notice?.toneClass).toBe(NEUTRAL_PROVENANCE);
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

describe("buildReserveSyncNotice", () => {
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
    expect(buildReserveSyncNotice(makeReserves({ mode: "live", sync: makeSync() }))).toBeNull();
    expect(buildReserveSyncNotice(makeReserves({ mode: "live" }))).toBeNull();
  });

  it("ok status with uncertain write → degraded notice (partial data)", () => {
    const notice = buildReserveSyncNotice(
      makeReserves({ mode: "live", sync: makeSync({ status: "ok", uncertainWrite: true }) }),
    );
    expect(notice?.title).toBe("Live reserve sync degraded");
    expect(notice?.rows).toContain("Status: ok");
    expect(notice?.rows).toContain("Latest write state uncertain");
    expect(notice?.toneClass).toBe(AMBER);
  });

  it("error status with full failure detail → destructive notice (full data)", () => {
    const notice = buildReserveSyncNotice(
      makeReserves({
        mode: "live",
        sync: makeSync({ status: "error", failureCategory: "upstream", lastError: "503 from adapter", uncertainWrite: true }),
      }),
    );
    expect(notice?.title).toBe("Live reserve sync error");
    expect(notice?.rows).toEqual([
      "Status: error",
      "Failure category: upstream",
      "Last error: 503 from adapter",
      "Latest write state uncertain",
    ]);
    expect(notice?.toneClass).toBe(DESTRUCTIVE);
  });

  it("degraded status → amber degraded notice", () => {
    const notice = buildReserveSyncNotice(makeReserves({ mode: "live", sync: makeSync({ status: "degraded" }) }));
    expect(notice?.title).toBe("Live reserve sync degraded");
    expect(notice?.toneClass).toBe(AMBER);
  });
});
