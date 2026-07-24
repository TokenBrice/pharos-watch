import { describe, expect, it } from "vitest";
import {
  ReportCardEvidenceJournalByIdV1Schema,
  ReportCardEvidenceJournalV1Schema,
  ReserveEvidenceAdmissionCodeSchema,
  ReserveEvidenceAttemptCodeSchema,
  ReserveEvidenceFallbackCodeSchema,
  ReserveEvidenceSourceOriginClassSchema,
  createReportCardEvidenceJournalV1,
  type ReportCardEvidenceJournalV1Payload,
} from "../report-card-evidence-journal";

const DIGEST = "a".repeat(64);

function payload(
  assetId: string,
  attemptId: string,
  attemptedAtSec: number,
  overrides: Partial<ReportCardEvidenceJournalV1Payload> = {},
): ReportCardEvidenceJournalV1Payload {
  return {
    schemaVersion: 1,
    lane: "reserve",
    assetId,
    attemptId,
    sourceId: "fixture-reserve-adapter",
    sourceOriginClass: "onchain-observation",
    attemptCode: "reserve.collector.attempted",
    admissionCode: "reserve.admission.accepted",
    fallbackCode: "reserve.fallback.not-used",
    attemptedAtSec,
    completedAtSec: attemptedAtSec + 1,
    sourceTimestampSec: attemptedAtSec,
    sourceBlock: null,
    contentSha256: DIGEST,
    sidecarMaterializationSha256: null,
    ...overrides,
  };
}

describe("report-card evidence journal runtime", () => {
  it("keeps the reserve outcome vocabulary explicit and stable", () => {
    expect(ReserveEvidenceAttemptCodeSchema.options).toEqual([
      "reserve.collector.attempted",
      "reserve.collector.not-configured",
      "reserve.collector.deferred",
    ]);
    expect(ReserveEvidenceAdmissionCodeSchema.options).toEqual([
      "reserve.admission.accepted",
      "reserve.admission.not-evaluated",
      "reserve.admission.rejected-upstream",
      "reserve.admission.rejected-timeout",
      "reserve.admission.rejected-invalid-payload",
      "reserve.admission.rejected-schema-drift",
      "reserve.admission.rejected-stale",
      "reserve.admission.rejected-reconciliation",
      "reserve.admission.rejected-sidecar-mismatch",
    ]);
    expect(ReserveEvidenceFallbackCodeSchema.options).toEqual([
      "reserve.fallback.not-used",
      "reserve.fallback.curated",
      "reserve.fallback.reviewed-sidecar",
      "reserve.fallback.last-known-good",
      "reserve.fallback.unavailable",
    ]);
    expect(ReserveEvidenceSourceOriginClassSchema.options).toEqual([
      "issuer-attested",
      "onchain-observation",
      "independent-assurance",
      "reviewed-curation",
      "unknown",
    ]);
  });

  it("canonicalizes asset and reserve-attempt ordering", () => {
    const alphaOld = createReportCardEvidenceJournalV1(payload("alpha", "attempt:old", 100));
    const alphaNew = createReportCardEvidenceJournalV1(payload("alpha", "attempt:new", 200));
    const beta = createReportCardEvidenceJournalV1(payload("beta", "attempt:beta", 150));

    expect(
      ReportCardEvidenceJournalByIdV1Schema.parse({
        beta: [beta],
        alpha: [alphaNew, alphaOld],
      }),
    ).toEqual({
      alpha: [alphaOld, alphaNew],
      beta: [beta],
    });
  });

  it("rejects unknown fields, secret-bearing identifiers, and oversized records", () => {
    const valid = createReportCardEvidenceJournalV1(payload("alpha", "attempt:valid", 100));
    expect(() => ReportCardEvidenceJournalV1Schema.parse({ ...valid, rawResponse: "not allowed" })).toThrow();

    expect(() =>
      createReportCardEvidenceJournalV1(
        payload("alpha", "attempt:secret", 100, {
          sourceId: "https://issuer.example/reserves",
        }),
      ),
    ).toThrow(/credentials|secret-bearing|URLs/);

    expect(() =>
      createReportCardEvidenceJournalV1(
        payload("alpha", `attempt:${"a".repeat(184)}`, 100, {
          sourceId: `source:${"s".repeat(184)}`,
          sourceBlock: {
            chainId: `chain:${"c".repeat(185)}`,
            blockNumber: 1,
            blockHash: DIGEST,
          },
          sidecarMaterializationSha256: DIGEST,
        }),
      ),
    ).toThrow(/exceeds 1024 bytes/);
  });

  it("requires coherent attempted, admitted, rejected, and fallback states", () => {
    expect(() =>
      createReportCardEvidenceJournalV1(
        payload("alpha", "attempt:stale", 100, {
          admissionCode: "reserve.admission.rejected-stale",
          fallbackCode: "reserve.fallback.curated",
          contentSha256: null,
        }),
      ),
    ).not.toThrow();

    expect(() =>
      createReportCardEvidenceJournalV1(
        payload("alpha", "attempt:invalid", 100, {
          admissionCode: "reserve.admission.rejected-stale",
          fallbackCode: "reserve.fallback.not-used",
          contentSha256: null,
        }),
      ),
    ).toThrow(/fallback disposition/);
  });
});
