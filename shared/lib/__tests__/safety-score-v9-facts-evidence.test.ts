import { describe, expect, it } from "vitest";
import {
  createV9EvidenceReference,
  createV9FactStatus,
  notApplicableV9Fact,
  requiredV9Applicability,
  unresolvedV9Applicability,
} from "../safety-score-v9/evidence";
import {
  collateralExposureV9Path,
  createV9FactGap,
  createV9FactGapV3,
  optionalExitV9Path,
} from "../safety-score-v9/reasons";
import {
  V9FactGapV2Schema,
  V9FactGapV3Schema,
} from "../../types/safety-score-v9-facts";

describe("Safety Score v9 evidence, applicability, and reason helpers", () => {
  it("preserves observed, published, rejected, current, and stale source states", () => {
    const observed = createV9EvidenceReference(
      {
        evidenceId: "e:observed",
        sourceId: "source",
        sourceGenerationId: "source:g1",
        disposition: "observed",
        observedAtSec: 900,
        maxAgeSec: 200,
      },
      1_000,
    );
    const published = createV9EvidenceReference(
      {
        evidenceId: "e:published",
        sourceId: "source",
        sourceGenerationId: "source:g1",
        disposition: "published",
        observedAtSec: 700,
        publishedAtSec: 710,
        maxAgeSec: 200,
      },
      1_000,
    );
    const rejected = createV9EvidenceReference(
      {
        evidenceId: "e:rejected",
        sourceId: "source",
        sourceGenerationId: "source:g1",
        disposition: "rejected",
        observedAtSec: 800,
        rejection: { code: "conflict", reason: "Conflicts with the bound producer generation.", rejectedAtSec: 850 },
      },
      1_000,
    );

    expect(observed.freshness).toEqual({ state: "current", ageSec: 100, maxAgeSec: 200 });
    expect(published.freshness).toEqual({ state: "stale", ageSec: 300, maxAgeSec: 200 });
    expect(rejected).toMatchObject({
      disposition: "rejected",
      freshness: { state: "not-assessed", ageSec: 200, maxAgeSec: null },
      rejection: { code: "conflict", rejectedAtSec: 850 },
    });
  });

  it("keeps evidence current through maxAgeSec and expires it one second later", () => {
    const source = {
      evidenceId: "e:boundary", sourceId: "source", sourceGenerationId: "source:g1",
      disposition: "observed" as const, observedAtSec: 800, maxAgeSec: 200,
    };
    expect(createV9EvidenceReference(source, 1_000).freshness).toEqual({
      state: "current", ageSec: 200, maxAgeSec: 200,
    });
    expect(createV9EvidenceReference(source, 1_001).freshness).toEqual({
      state: "stale", ageSec: 201, maxAgeSec: 200,
    });
  });

  it("rejects future publication and rejection clocks independently of observation", () => {
    const source = {
      evidenceId: "e:clock", sourceId: "source", sourceGenerationId: "source:g1", observedAtSec: 900,
    };
    const published = { ...source, disposition: "published" as const, publishedAtSec: 1_000 };
    const rejected = {
      ...source, disposition: "rejected" as const,
      rejection: { code: "conflict", reason: "Conflicting generation", rejectedAtSec: 1_000 },
    };
    expect(createV9EvidenceReference(published, 1_000).disposition).toBe("published");
    expect(createV9EvidenceReference(rejected, 1_000).disposition).toBe("rejected");
    expect(() => createV9EvidenceReference({ ...published, publishedAtSec: 1_001 }, 1_000)).toThrow();
    expect(() => createV9EvidenceReference({
      ...rejected, rejection: { ...rejected.rejection, rejectedAtSec: 1_001 },
    }, 1_000)).toThrow();
  });

  it("rejects future source times and contradictory source dispositions", () => {
    expect(() =>
      createV9EvidenceReference(
        {
          evidenceId: "e:future",
          sourceId: "source",
          sourceGenerationId: "source:g1",
          disposition: "observed",
          observedAtSec: 1_001,
        },
        1_000,
      ),
    ).toThrow("later than asOfSec");
    expect(() =>
      createV9EvidenceReference(
        {
          evidenceId: "e:published",
          sourceId: "source",
          sourceGenerationId: "source:g1",
          disposition: "published",
          observedAtSec: 900,
        },
        1_000,
      ),
    ).toThrow("Published evidence requires");
    expect(() =>
      createV9EvidenceReference(
        {
          evidenceId: "e:rejected",
          sourceId: "source",
          sourceGenerationId: "source:g1",
          disposition: "rejected",
          observedAtSec: 900,
        },
        1_000,
      ),
    ).toThrow("Rejected evidence requires");
  });

  it("keeps applicability independent from observation state", () => {
    expect(
      createV9FactStatus({
        applicability: requiredV9Applicability("backing.reserve.required"),
        observationState: "missing",
        gapIds: ["gap:reserve"],
      }),
    ).toMatchObject({ applicability: { state: "required" }, observationState: "missing" });
    expect(
      createV9FactStatus({
        applicability: notApplicableV9Fact("control.oracle.applicability", "No oracle-mediated mint path exists."),
        observationState: "known",
        evidenceRefIds: ["e:review"],
      }),
    ).toMatchObject({ applicability: { state: "not-applicable" }, observationState: "known" });
    expect(
      createV9FactStatus({
        applicability: unresolvedV9Applicability(
          "control.oracle.applicability",
          "Oracle branch applicability is unresolved.",
          "gap:oracle",
        ),
        observationState: "missing",
        gapIds: ["gap:oracle"],
      }),
    ).toMatchObject({ applicability: { state: "unresolved" }, observationState: "missing" });

    expect(() =>
      createV9FactStatus({
        applicability: notApplicableV9Fact("control.oracle.applicability", "Not applicable."),
        observationState: "missing",
        gapIds: ["gap:oracle"],
      }),
    ).toThrow("not-applicable facts must be known");
    expect(() =>
      createV9FactStatus({
        applicability: requiredV9Applicability("backing.reserve.required"),
        observationState: "stale",
        gapIds: ["gap:reserve"],
      }),
    ).toThrow("requires evidence");
  });


  it("versions evidence responsibility without weakening retained V2 parsing", () => {
    const retained = createV9FactGap({
      gapId: "gap:retained",
      reasonCode: "missing-runtime-route-evidence",
      ownerDomain: "exit",
      policyRuleId: "exit.runtime",
      observationState: "stale",
      path: optionalExitV9Path("dex:dex:g1:retained"),
      message: "Retained route evidence is stale.",
    });
    expect(V9FactGapV2Schema.parse(retained)).toEqual(retained);
    expect(() => V9FactGapV3Schema.parse(retained)).toThrow();
    expect(() => V9FactGapV2Schema.parse({ ...retained, responsibility: "producer-failed" })).toThrow(
      "Unrecognized key",
    );

    const current = createV9FactGapV3({ ...retained, responsibility: "producer-failed" });
    expect(current).toMatchObject({ responsibility: "unresearched", causeProof: { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] } });
    expect(V9FactGapV3Schema.parse(current)).toEqual(current);
  });

  it("keeps expired/absent/unknown publication history at U until a current cause is proved", () => {
    const expiredPublication = createV9EvidenceReference(
      {
        evidenceId: "e:expired-publication",
        sourceId: "issuer-reserve-report",
        sourceGenerationId: "issuer-reserve-report:g1",
        disposition: "published",
        observedAtSec: 700,
        publishedAtSec: 710,
        maxAgeSec: 200,
      },
      1_000,
    );
    const gap = {
      gapId: "gap:expired-publication",
      reasonCode: "missing-latest-assurance-report" as const,
      ownerDomain: "backing" as const,
      policyRuleId: "backing.assurance.current",
      observationState: "stale" as const,
      path: collateralExposureV9Path("reserve:cash"),
      message: "The published assurance report is outside the freshness window.",
      evidenceRefIds: [expiredPublication.evidenceId],
      responsibility: "issuer-undisclosed" as const,
    };

    const withIssuerHistory = createV9FactGapV3({
      ...gap,
      evidenceHistory: { publishedBy: "issuer", references: [expiredPublication] },
    });
    expect(withIssuerHistory.responsibility).toBe("unresearched");
    expect(withIssuerHistory.causeProof.cause).toBe("U");
    expect(withIssuerHistory.evidenceHistory).toEqual({ publishedBy: "issuer", evidenceRefIds: [expiredPublication.evidenceId] });
    expect(createV9FactGapV3({
      ...gap,
      evidenceHistory: { publishedBy: "parent", references: [expiredPublication] },
    }).responsibility).toBe("unresearched");
    expect(createV9FactGapV3({
      ...gap,
      evidenceHistory: { publishedBy: "issuer", references: [] },
    }).responsibility).toBe("unresearched");
    expect(createV9FactGapV3({
      ...gap,
      evidenceHistory: { publishedBy: "unknown", references: [expiredPublication] },
    }).responsibility).toBe("unresearched");
    const observedOnly = createV9EvidenceReference({
      evidenceId: "e:observed-only", sourceId: "issuer-reserve-report", sourceGenerationId: "report:g1",
      disposition: "observed", observedAtSec: 700, maxAgeSec: 200,
    }, 1_000);
    const currentPublication = createV9EvidenceReference({
      evidenceId: "e:current", sourceId: "issuer-reserve-report", sourceGenerationId: "report:g2",
      disposition: "published", observedAtSec: 900, publishedAtSec: 910, maxAgeSec: 200,
    }, 1_000);
    for (const reference of [observedOnly, currentPublication]) {
      expect(createV9FactGapV3({
        ...gap,
        evidenceHistory: { publishedBy: "issuer", references: [reference] },
      }).responsibility).toBe("unresearched");
    }
    expect(createV9FactGapV3({
      ...gap,
      observationState: "missing",
      evidenceHistory: { publishedBy: "issuer", references: [expiredPublication] },
    }).responsibility).toBe("unresearched");
  });
});
