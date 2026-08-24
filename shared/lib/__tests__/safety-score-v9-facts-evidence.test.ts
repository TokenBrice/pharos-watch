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
  deploymentControlV9Path,
  optionalExitV9Path,
  serialDependencyV9Path,
} from "../safety-score-v9/reasons";
import {
  V9FactGapV2Schema,
  V9FactGapV3Schema,
} from "../../types/safety-score-v9-facts";
import { V9EvidenceResponsibilitySchema } from "../../types/safety-score-v9-fact-primitives";

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

  it("constructs every typed economic path and reason-coded gap", () => {
    const paths = [
      serialDependencyV9Path("parent", "wrapper"),
      collateralExposureV9Path("exposure:cash"),
      deploymentControlV9Path("deployment:ethereum", "control:admin"),
      optionalExitV9Path("dex:dex:g1:pool"),
    ];
    expect(paths.map((path) => path.kind)).toEqual([
      "serial-dependency",
      "collateral-exposure",
      "deployment-control",
      "optional-exit",
    ]);
    expect(
      createV9FactGap({
        gapId: "gap:output",
        reasonCode: "unresolved-exit-output",
        ownerDomain: "exit",
        policyRuleId: "exit.output.valuation",
        observationState: "missing",
        path: paths[3]!,
        message: "The route output cannot be valued at the fact-set clock.",
      }),
    ).toMatchObject({
      ownerDomain: "exit",
      policyRuleId: "exit.output.valuation",
      reasonCode: "unresolved-exit-output",
      path: { kind: "optional-exit" },
    });
  });

  it("versions evidence responsibility without weakening retained V2 parsing", () => {
    expect(V9EvidenceResponsibilitySchema.options).toEqual([
      "measured-adverse",
      "issuer-undisclosed",
      "integration-missing",
      "producer-failed",
      "method-unsupported",
      "published-evidence-expired",
    ]);
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
    expect(V9FactGapV3Schema.parse(current)).toEqual(current);
    expect(() => createV9FactGapV3({ ...retained, responsibility: "publisher-late" as never })).toThrow();
  });

  it("assigns expired published evidence to Pharos and keeps absent or unknown history fail-closed", () => {
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

    expect(createV9FactGapV3({
      ...gap,
      evidenceHistory: { publishedBy: "issuer", references: [expiredPublication] },
    }).responsibility).toBe("published-evidence-expired");
    expect(createV9FactGapV3({
      ...gap,
      evidenceHistory: { publishedBy: "parent", references: [expiredPublication] },
    }).responsibility).toBe("published-evidence-expired");
    expect(createV9FactGapV3({
      ...gap,
      evidenceHistory: { publishedBy: "issuer", references: [] },
    }).responsibility).toBe("issuer-undisclosed");
    expect(createV9FactGapV3({
      ...gap,
      evidenceHistory: { publishedBy: "unknown", references: [expiredPublication] },
    }).responsibility).toBe("issuer-undisclosed");
  });
});
