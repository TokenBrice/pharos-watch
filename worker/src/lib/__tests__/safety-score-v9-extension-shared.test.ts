import { describe, expect, it } from "vitest";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import {
  ReviewEvidenceBuilder,
  accessEvidenceObservationState,
  boundedObservedAt,
  confidenceForResearch,
  conservativeDateEndSec,
  maximumObservedAt,
  notApplicableStatus,
  parseBoundedDateSec,
  projectControlAuthority,
  requiredStatus,
  researchReviewObservationState,
  reviewedObservationState,
} from "../safety-score-v9/extension-shared";

const CLOCK_SEC = Date.parse("2026-09-21T00:00:00.000Z") / 1_000;

describe("Safety Score v9 bounded review dates", () => {
  it("rejects a malformed assurance review date as invalid", () => {
    expect(() => parseBoundedDateSec("not-a-date", CLOCK_SEC, "assurance")).toThrow(
      "Safety Score v9 assurance has an invalid review date",
    );
  });

  it("rejects an assurance review date later than the scoring clock", () => {
    expect(() => parseBoundedDateSec("2026-09-22", CLOCK_SEC, "assurance")).toThrow(
      "Safety Score v9 assurance review is later than the scoring clock",
    );
  });
});

describe("review evidence timestamp admission", () => {
  const base = {
    componentKeys: ["allocation"], sourceId: "fixture:review",
    reviewedAtSec: CLOCK_SEC - 10, observedAtSec: CLOCK_SEC - 20, payload: { scope: "contract" },
  };

  it.each([
    { reviewedAt: undefined, reviewedAtSec: undefined },
    { reviewedAt: "2026-09-20", reviewedAtSec: CLOCK_SEC - 10 },
  ])("requires exactly one review clock: %j", (dates) => {
    const builder = new ReviewEvidenceBuilder("alpha", CLOCK_SEC);
    expect(() => builder.add({ ...base, ...dates })).toThrow("exactly one reviewed date or timestamp");
    expect(builder.finish()).toEqual({ researchEvidence: [], componentEvidence: [] });
  });

  it.each([CLOCK_SEC + 1, -1, NaN, Infinity, CLOCK_SEC - 0.5])("rejects invalid numeric clocks %s without admitting evidence", (timestamp) => {
    for (const field of ["reviewedAtSec", "observedAtSec"] as const) {
      const builder = new ReviewEvidenceBuilder("alpha", CLOCK_SEC);
      expect(() => builder.add({ ...base, [field]: timestamp })).toThrow("timestamp is invalid or later than the scoring clock");
      expect(builder.finish()).toEqual({ researchEvidence: [], componentEvidence: [] });
    }
  });

  it("rejects an observation newer than its review", () => {
    const builder = new ReviewEvidenceBuilder("alpha", CLOCK_SEC);
    expect(() => builder.add({ ...base, observedAtSec: CLOCK_SEC - 9 })).toThrow("Evidence observation cannot postdate review");
    expect(builder.finish()).toEqual({ researchEvidence: [], componentEvidence: [] });
  });

  it("preserves numeric observation and publication provenance and deduplicates evidence bindings", () => {
    const builder = new ReviewEvidenceBuilder("alpha", CLOCK_SEC);
    const args = {
      ...base, componentKeys: ["leverage", "allocation"],
      sources: [
        { label: "Z report", url: "https://example.test/z" },
        { label: "A report", url: "https://example.test/a" },
      ],
      publishedAt: "2026-09-19", publishedBy: "issuer" as const,
      confidence: "verified" as const, maxAgeSec: 300,
    };
    const keys = builder.add(args);
    const repeatedKeys = builder.add({ ...args, sources: [...args.sources].reverse() });
    expect(repeatedKeys).toEqual(keys);
    const result = builder.finish();
    expect(result.researchEvidence.map((entry) => [entry.url, entry.observedAtSec, entry.publishedAtSec, entry.publishedBy, entry.maxAgeSec])).toEqual([
      ["https://example.test/a", CLOCK_SEC - 20, Date.parse("2026-09-19T00:00:00Z") / 1000, "issuer", 300],
      ["https://example.test/z", CLOCK_SEC - 20, Date.parse("2026-09-19T00:00:00Z") / 1000, "issuer", 300],
    ]);
    expect(result.componentEvidence).toEqual([
      { componentKey: "allocation", evidenceKeys: [...keys].sort() },
      { componentKey: "leverage", evidenceKeys: [...keys].sort() },
    ]);
    const changed = builder.add({ ...args, payload: { scope: "legal" }, componentKeys: ["allocation"] });
    expect(changed.every((key) => !keys.includes(key))).toBe(true);
  });

  it("uses the review clock only when no observation clock is recorded, and retains unsourced evidence honestly", () => {
    const builder = new ReviewEvidenceBuilder("alpha", CLOCK_SEC);
    const numericKeys = builder.add({ ...base, observedAtSec: undefined });
    const datedKeys = builder.add({
      componentKeys: ["custody"], sourceId: "fixture:dated", reviewedAt: "2026-09-20",
      observedAt: "2026-09-19", payload: {},
    });
    const result = builder.finish();
    expect(result.researchEvidence.find((entry) => entry.evidenceKey === numericKeys[0])).toMatchObject({
      observedAtSec: CLOCK_SEC - 10, publishedAtSec: null, url: null, confidence: "manual-review", maxAgeSec: null,
    });
    expect(result.researchEvidence.find((entry) => entry.evidenceKey === datedKeys[0])).toMatchObject({
      observedAtSec: Date.parse("2026-09-19T00:00:00Z") / 1000,
      publishedAtSec: null, url: null,
    });
  });
});

describe("conservative observation clocks", () => {
  it.each([
    ["2024-Q1", "2024-03-31T23:59:59Z"],
    ["2024", "2024-12-31T23:59:59Z"],
    ["2024-02", "2024-02-29T23:59:59Z"],
    ["2024-02-03", "2024-02-03T00:00:00Z"],
  ])("uses the end of a partially disclosed period %s", (value, expected) => {
    expect(conservativeDateEndSec(value, CLOCK_SEC)).toBe(Date.parse(expected) / 1000);
  });

  it("does not admit a period whose conservative end postdates the scoring clock", () => {
    const end = Date.parse("2026-09-30T23:59:59Z") / 1000;
    expect(conservativeDateEndSec("2026-09", end - 1)).toBeNull();
    expect(conservativeDateEndSec("2026-09", end)).toBe(end);
    expect(conservativeDateEndSec("invalid", CLOCK_SEC)).toBeNull();
    expect(conservativeDateEndSec(undefined, CLOCK_SEC)).toBeNull();
  });

  it("bounds finite observed clocks and ignores absent or nonfinite candidates when choosing the latest", () => {
    expect(boundedObservedAt(CLOCK_SEC + 10, CLOCK_SEC)).toBe(CLOCK_SEC);
    expect(boundedObservedAt(-1, CLOCK_SEC)).toBe(0);
    expect(boundedObservedAt(12.9, CLOCK_SEC)).toBe(12);
    expect(boundedObservedAt(NaN, CLOCK_SEC)).toBe(CLOCK_SEC);
    expect(maximumObservedAt([undefined, null, NaN, Infinity, 10, 20.9], 30, CLOCK_SEC)).toBe(20);
    expect(maximumObservedAt([undefined, null, NaN], 30, CLOCK_SEC)).toBe(30);
  });

  it.each([
    ["access", accessEvidenceObservationState, V9_ACCESS_EVIDENCE_MAX_AGE_SEC],
    ["research", researchReviewObservationState, V9_REVIEW_EVIDENCE_MAX_AGE_SEC],
  ] as const)("admits the exact %s evidence-age limit but not a stale or invalid review", (_, resolve, maxAge) => {
    const reviewedAt = "2026-09-20";
    const reviewSec = Date.parse(`${reviewedAt}T00:00:00Z`) / 1000;
    expect(resolve(reviewedAt, reviewSec + maxAge)).toBe("current");
    expect(resolve(reviewedAt, reviewSec + maxAge + 1)).toBe("stale");
    expect(() => resolve(reviewedAt, reviewSec - 1)).toThrow(/later than the scoring clock/);
    expect(() => resolve("invalid", CLOCK_SEC)).toThrow(/invalid review date/);
  });
});

describe("control authority scope", () => {
  it("keeps signer-count thresholds only for unweighted multisigs and preserves a chain-scoped authority identity", () => {
    expect(projectControlAuthority({ authorityType: "safe", chain: "ethereum", address: "0xABC", fallbackKey: "unused", threshold: 2, signerCount: 3 }))
      .toEqual({ authorityKey: "ethereum:0xabc", model: "multisig", threshold: { required: 2, total: 3 } });
    expect(projectControlAuthority({ authorityType: "safe", fallbackKey: "reviewed-safe", threshold: 2 }))
      .toEqual({ authorityKey: "reviewed-safe", model: "multisig", threshold: null });
    expect(projectControlAuthority({ authorityType: "eoa", fallbackKey: "reviewed-eoa", threshold: 1, signerCount: 1 }))
      .toEqual({ authorityKey: "reviewed-eoa", model: "eoa", threshold: null });
    expect(projectControlAuthority({ authorityType: "unknown", fallbackKey: null })).toBeNull();
  });

  it.each([
    ["dao-governor", "governance"], ["issuer-backend", "issuer-backend"], ["custodian", "issuer-backend"],
    ["validator-quorum", "validator-quorum"], ["contract", "contract"], ["timelock", "contract"],
    ["bridge", "contract"], ["none", "none"], ["unknown", "unknown"],
  ] as const)("does not invent multisig quorum from counts on %s authority", (authorityType, model) => {
    expect(projectControlAuthority({ authorityType, fallbackKey: "reviewed-authority", threshold: 2, signerCount: 3 }))
      .toEqual({ authorityKey: "reviewed-authority", model, threshold: null });
  });
});

describe("evidence disposition", () => {
  it("keeps weak evidence bounded or missing rather than promoting it to known", () => {
    expect(reviewedObservationState(confidenceForResearch(undefined))).toBe("known");
    expect(reviewedObservationState(confidenceForResearch("limited"))).toBe("bounded-unknown");
    expect(reviewedObservationState(confidenceForResearch("unknown"))).toBe("missing");
    expect(requiredStatus("rule", "missing", "allocation", ["evidence"])).toMatchObject({
      evidenceRefIds: [], gapIds: ["extension-gap:allocation"],
    });
    expect(requiredStatus("rule", "stale", "allocation", ["evidence"])).toMatchObject({
      evidenceRefIds: ["evidence"], gapIds: ["extension-gap:allocation"],
    });
    expect(requiredStatus("rule", "known", "allocation", ["evidence"])).toMatchObject({
      evidenceRefIds: ["evidence"], gapIds: [],
    });
    expect(notApplicableStatus("rule", "No addressable surface", [])).toMatchObject({
      applicability: { state: "not-applicable", rationale: "No addressable surface" },
      observationState: "known", evidenceRefIds: ["extension-evidence:rule"], gapIds: [],
    });
    expect(notApplicableStatus("rule", "Reviewed scope", ["evidence"]).evidenceRefIds).toEqual(["evidence"]);
  });
});
