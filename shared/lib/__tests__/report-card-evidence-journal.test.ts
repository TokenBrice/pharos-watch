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

    const canonical = ReportCardEvidenceJournalByIdV1Schema.parse({
      beta: [beta],
      alpha: [alphaNew, alphaOld],
    });

    expect(canonical).toEqual({
      alpha: [alphaOld, alphaNew],
      beta: [beta],
    });
    expect(alphaOld.journalId).toBe(
      "report-card-evidence:v1:737810dca00eb6f9f55ce9e5926a56a89232dd71dc86cdddddfd83dbc017f3b2",
    );
    expect(Object.keys(canonical)).toEqual(["alpha", "beta"]);
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(ReportCardEvidenceJournalByIdV1Schema.parse({
      alpha: [alphaOld, alphaNew],
      beta: [beta],
    })));
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

  it("allows timestamp equality but rejects inverted chronology", () => {
    const equal = payload("alpha", "attempt:equal", 100, { completedAtSec: 100 });
    expect(createReportCardEvidenceJournalV1(equal)).toMatchObject({
      attemptedAtSec: 100, completedAtSec: 100, sourceTimestampSec: 100,
    });
    expect(() => createReportCardEvidenceJournalV1({ ...equal, attemptedAtSec: 101 })).toThrow();
    expect(() => createReportCardEvidenceJournalV1({ ...equal, sourceTimestampSec: 101 })).toThrow();
  });

  it("requires evaluation exactly when collection was attempted", () => {
    const skipped = payload("alpha", "attempt:skipped", 100, {
      attemptCode: "reserve.collector.deferred",
      admissionCode: "reserve.admission.not-evaluated",
      fallbackCode: "reserve.fallback.unavailable",
      contentSha256: null,
    });
    expect(createReportCardEvidenceJournalV1(skipped).admissionCode).toBe("reserve.admission.not-evaluated");
    expect(() => createReportCardEvidenceJournalV1({
      ...skipped, attemptCode: "reserve.collector.attempted",
    })).toThrow();
    const accepted = payload("alpha", "attempt:accepted", 100);
    expect(createReportCardEvidenceJournalV1(accepted).admissionCode).toBe("reserve.admission.accepted");
    expect(() => createReportCardEvidenceJournalV1({
      ...accepted, attemptCode: "reserve.collector.not-configured",
    })).toThrow();
  });

  it("requires accepted content without a fallback", () => {
    const accepted = payload("alpha", "attempt:accepted", 100);
    expect(createReportCardEvidenceJournalV1(accepted).contentSha256).toBe(DIGEST);
    expect(() => createReportCardEvidenceJournalV1({
      ...accepted, fallbackCode: "reserve.fallback.curated",
    })).toThrow();
    expect(() => createReportCardEvidenceJournalV1({ ...accepted, contentSha256: null })).toThrow();
  });

  it.each([
    ["reserve.admission.rejected-sidecar-mismatch", "reserve.fallback.curated"],
    ["reserve.admission.rejected-stale", "reserve.fallback.reviewed-sidecar"],
  ] as const)("requires materialization for %s / %s", (admissionCode, fallbackCode) => {
    const reviewed = payload("alpha", "attempt:sidecar", 100, {
      admissionCode, fallbackCode, contentSha256: null, sidecarMaterializationSha256: DIGEST,
    });
    expect(createReportCardEvidenceJournalV1(reviewed).sidecarMaterializationSha256).toBe(DIGEST);
    expect(() => createReportCardEvidenceJournalV1({
      ...reviewed, sidecarMaterializationSha256: null,
    })).toThrow();
  });
});
