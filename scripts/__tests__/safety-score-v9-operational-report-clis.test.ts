import { describe, expect, it } from "vitest";
import policyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import { compileV9FactSetV3 } from "@shared/lib/safety-score-v9/compile";
import { buildV9EvidenceGapQueue, parseV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { loadV9MethodologyPolicy, resolveV9ReasonPolicy } from "@shared/lib/safety-score-v9/policy";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  V9EvidenceGapQueueV1Schema,
  V9EvidenceGapQueueV2Schema,
} from "@shared/types/safety-score-v9-evidence-queue";
import type { V9EvidenceResponsibility } from "@shared/types/safety-score-v9-fact-primitives";
import type { V9FactSetCoreV3 } from "@shared/types/safety-score-v9-facts";
import {
  runV9EvidenceGapQueueCli,
  type V9EvidenceGapQueueIo,
} from "../maintenance/generate-safety-score-v9-evidence-gap-queue";

const AS_OF_SEC = 1_000;
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(64)}`;

function source(generationId: string, character: string) {
  return { generationId, payloadSha256: character.repeat(64), observedAtSec: 900 };
}

const SOURCES = {
  registry: source("registry:g1", "1"),
  dex: source("dex:g1", "2"),
  redemption: source("redemption:g1", "3"),
  liveReserves: source("reserves:g1", "4"),
  chainSupply: source("supply:g1", "5"),
  peg: source("peg:g1", "6"),
  researchOverlays: source("research:g1", "7"),
};

const EVIDENCE = {
  evidenceId: "evidence:current",
  sourceId: "fixture",
  sourceGenerationId: "fixture:g1",
  disposition: "observed" as const,
  observedAtSec: 900,
  publishedAtSec: null,
  url: null,
  contentSha256: null,
  freshness: { state: "current" as const, ageSec: 100, maxAgeSec: 200 },
  rejection: null,
};

function knownStatus(policyRuleId: string) {
  return {
    applicability: { state: "required" as const, policyRuleId, rationale: null, gapId: null },
    observationState: "known" as const,
    evidenceRefIds: [EVIDENCE.evidenceId],
    gapIds: [],
  };
}

function notApplicableStatus(policyRuleId: string) {
  return {
    applicability: {
      state: "not-applicable" as const,
      policyRuleId,
      rationale: "Reviewed as not applicable.",
      gapId: null,
    },
    observationState: "known" as const,
    evidenceRefIds: [EVIDENCE.evidenceId],
    gapIds: [],
  };
}

function mechanismFact(policyRuleId: string) {
  return {
    status: knownStatus(policyRuleId),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "mechanism:fixture" }],
  };
}

function factSetCore(message = "Launch date evidence has not been established."): V9FactSetCoreV3 {
  const gapId = "asset-001:gap:implementation-date";
  return {
    schemaVersion: 3,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    asOfSec: AS_OF_SEC,
    compiledAtSec: 1_100,
    sourceFingerprints: SOURCES,
    activeAssetIds: ["asset-001"],
    assets: [
      {
        assetId: "asset-001",
        archetype: "algorithmic",
        evidence: [EVIDENCE],
        gaps: [
          {
            gapId,
            reasonCode: "missing-implementation-date",
            ownerDomain: "evidence",
            policyRuleId: "v9.implementation.launch-date",
            observationState: "missing",
            path: { kind: "local-component", componentKey: "implementation.launch-date" },
            message,
            evidenceRefIds: [],
            responsibility: "integration-missing",
          },
        ],
        wrapperLocalFacts: {
          schemaVersion: 1,
          applicability: "not-wrapper",
          evidenceRefIds: [],
        },
        implementation: {
          status: {
            applicability: {
              state: "required",
              policyRuleId: "v9.implementation.launch-date",
              rationale: null,
              gapId: null,
            },
            observationState: "missing",
            evidenceRefIds: [],
            gapIds: [gapId],
          },
          launchedAtSec: null,
        },
        mechanismRiskReview: {
          status: knownStatus("v9.backing.mechanism"),
          review: {
            archetype: "algorithmic",
            exogenousBackingShare: 1,
            reflexiveBackingShare: 0,
            contractionCapacityRatio: 1,
            contractionCapacity: mechanismFact("v9.backing.contraction"),
            confidenceAndIncentives: mechanismFact("v9.backing.confidence"),
            oracleAndControlAssumptions: mechanismFact("v9.backing.oracle"),
            emergencyRecovery: mechanismFact("v9.backing.emergency"),
            lossRecovery: mechanismFact("v9.backing.loss"),
          },
        },
        dependencies: {
          status: knownStatus("v9.dependencies"),
          sourceGenerationId: SOURCES.researchOverlays.generationId,
          source: "none",
          baseSource: "none",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges: [],
          diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
        },
        reserveStatus: notApplicableStatus("v9.reserve.not-applicable"),
        reserveExposures: [],
        exitStatus: notApplicableStatus("v9.exit.not-applicable"),
        exitRoutes: [],
        controlStatus: notApplicableStatus("v9.control.not-applicable"),
        controls: [],
        economicControlReview: {
          mint: {
            status: notApplicableStatus("v9.control.mint.not-applicable"),
            controlKey: null,
            reconciliation: "not-applicable",
            supervision: "unknown",
            latestResolvedIncidentAtSec: null,
            upgrade: { state: "not-applicable", controlKey: null },
          },
          oracle: {
            status: notApplicableStatus("v9.control.oracle.not-applicable"),
            tier: null,
            branches: [],
          },
          bridge: { status: notApplicableStatus("v9.control.bridge.not-applicable"), routes: [] },
        },
        accessReview: {
          transfer: { status: knownStatus("v9.access.transfer"), posture: "permissionless" },
          freeze: { status: notApplicableStatus("v9.access.freeze.not-applicable"), reviews: [] },
        },
        peg: {
          status: knownStatus("v9.peg"),
          pegKey: "peg:usd",
          sourceGenerationId: SOURCES.peg.generationId,
          referenceKind: "fiat",
          referenceKey: "USD",
          methodologyVersion: "fixture-v1",
          pegScore: 99,
          currentDeviationBps: 1,
          activeDepeg: false,
          activeDepegBps: null,
          trackingSpanDays: 365,
          failureDomains: [{ kind: "oracle-feed", key: "peg:fixture" }],
        },
        supply: {
          status: knownStatus("v9.supply"),
          sourceGenerationId: SOURCES.chainSupply.generationId,
          sourceKind: "usd-denominated-circulating",
          circulatingUnits: null,
          referencePriceUsd: null,
          circulatingUsd: 10_000_000,
          chainDistribution: {
            chains: [{ chainId: "chain:fixture", supplyUsd: 10_000_000, supplyShare: 1 }],
            unattributedSupplyUsd: 0,
            unattributedSupplyShare: 0,
          },
          selectedBridgeRoutes: [],
          selectedRouteSupplyShare: 0,
          unknownRouteSupplyShare: 0,
          unreviewedRouteSupplyShare: 0,
          failureDomains: [{ kind: "chain", key: "chain:fixture" }],
        },
      },
    ],
  };
}

/**
 * One asset whose only gap is a deployment-scoped control identity gap, as the
 * fact-set builder emits it for a bridge control with unresolved authority or
 * economic semantics. A null materialSupplyShare models the unmatched targets
 * whose deployment share cannot be attributed.
 */
function deploymentControlFactSetCore(
  deploymentKey: string,
  materialSupplyShare: number | null,
): V9FactSetCoreV3 {
  const core = factSetCore();
  const asset = core.assets[0]!;
  const controlKey = `bridge-supply:${asset.assetId}`;
  const gapId = `${asset.assetId}:gap:deployment-control:${controlKey}`;
  asset.gaps = [
    {
      gapId,
      reasonCode: "unresolved-control-identity",
      ownerDomain: "control",
      policyRuleId: "v9.control.review",
      observationState: "bounded-unknown",
      path: { kind: "deployment-control", deploymentKey, controlKey },
      message: "The control inventory is known, but this control's authority remains unresolved.",
      evidenceRefIds: [EVIDENCE.evidenceId],
      responsibility: "issuer-undisclosed",
    },
  ];
  asset.implementation.status = knownStatus("v9.implementation.launch-date");
  asset.implementation.launchedAtSec = 500;
  asset.controlStatus = knownStatus("v9.control.review");
  asset.controls = [
    {
      controlKey,
      deploymentKey,
      sourceGenerationId: SOURCES.researchOverlays.generationId,
      controlKind: "bridge",
      scope: "deployment",
      status: {
        applicability: {
          state: "required" as const,
          policyRuleId: "v9.control.review",
          rationale: null,
          gapId: null,
        },
        observationState: "bounded-unknown" as const,
        evidenceRefIds: [EVIDENCE.evidenceId],
        gapIds: [gapId],
      },
      capabilities: [],
      capSemantics: { kind: "unknown", bound: null },
      claimImpairment: "unknown",
      economicLossScope: "deployment",
      authority: { authorityKey: `bridge-route:${deploymentKey}`, model: "unknown", threshold: null },
      delaySec: null,
      materialSupplyShare,
      keyCustody: "unknown",
      modulesOrGuards: "unknown",
      incidentState: "unknown",
      failureDomains: [{ kind: "bridge-route", key: deploymentKey }],
    },
  ];
  return core;
}

function factSetV3WithResponsibility(responsibility: V9EvidenceResponsibility) {
  const core = structuredClone(factSetCore());
  core.assets[0]!.gaps[0]!.responsibility = responsibility;
  return compileV9FactSetV3(core);
}

function memoryIo(inputs: Record<string, unknown>) {
  const writes = new Map<string, string>();
  let stdout = "";
  const io = {
    readJson(path: string) {
      if (!(path in inputs)) throw new Error(`Missing fixture ${path}`);
      return inputs[path];
    },
    writeText(path: string, contents: string) {
      writes.set(path, contents);
    },
    stdout: {
      write(text: string) {
        stdout += text;
        return true;
      },
    },
  } satisfies V9EvidenceGapQueueIo;
  return { io, writes, getStdout: () => stdout };
}

describe("Safety Score v9 evidence-gap queue", () => {
  it("derives policy, applicability, materiality, owner, and action from typed facts", () => {
    const factSet = compileV9FactSetV3(
      factSetCore("This message deliberately says unsupported but is not classified."),
    );
    const queue = buildV9EvidenceGapQueue({ factSet, policy: loadV9MethodologyPolicy(policyAsset) });

    expect(V9EvidenceGapQueueV2Schema.parse(queue)).toEqual(queue);
    expect(queue).toMatchObject({
      schemaVersion: 2,
      purpose: "evidence-work-queue-not-release-gate",
      status: "work-required",
      facts: {
        sourceSchemaVersion: 3,
        sourceFactSetDigest: factSet.v9FactSetDigest,
      },
      summary: {
        gapCount: 1,
        criticalGapCount: 0,
        knownSupplyWeightGapCount: 1,
        policyBindingMismatchGapCount: 0,
        responsibilityCounts: expect.arrayContaining([
          { responsibility: "integration-missing", count: 1 },
          { responsibility: "issuer-undisclosed", count: 0 },
          { responsibility: "measured-adverse", count: 0 },
          { responsibility: "method-unsupported", count: 0 },
          { responsibility: "producer-failed", count: 0 },
        ]),
      },
    });
    expect(queue.facts.evaluationFactSetDigest).toBe(queue.facts.sourceFactSetDigest);
    expect(queue.entries[0]).toMatchObject({
      priority: 1,
      assetId: "asset-001",
      reasonCode: "missing-implementation-date",
      ownerDomain: "evidence",
      factOwnerDomain: "evidence",
      policyBindingIssues: [],
      applicability: "required",
      observationState: "missing",
      action: "collect-evidence",
      responsibility: "integration-missing",
      releaseSeverity: "review-required",
      treatment: "ceiling",
      critical: false,
      materiality: { basis: "asset-wide", fractionOfAsset: 1 },
      supplyWeight: { state: "current-valid", canonicalUsd: 10_000_000, materialityWeightedUsd: 10_000_000 },
    });
    expect(parseV9EvidenceGapQueue(queue)).toEqual(queue);
    expect(buildV9EvidenceGapQueue({ factSet, policy: loadV9MethodologyPolicy(policyAsset) }).queueDigest).toBe(
      queue.queueDigest,
    );
  });

  it.each([
    "issuer-undisclosed",
    "integration-missing",
    "producer-failed",
    "method-unsupported",
    "measured-adverse",
  ] as const)("preserves native V3 %s responsibility", (responsibility) => {
    const factSet = factSetV3WithResponsibility(responsibility);
    const queue = buildV9EvidenceGapQueue({ factSet, policy: loadV9MethodologyPolicy(policyAsset) });

    expect(queue.facts).toMatchObject({
      sourceSchemaVersion: 3,
      sourceFactSetDigest: factSet.v9FactSetDigest,
      evaluationFactSetDigest: factSet.v9FactSetDigest,
    });
    expect(queue.entries[0]?.responsibility).toBe(responsibility);
    expect(queue.summary.responsibilityCounts.find((entry) => entry.responsibility === responsibility)?.count).toBe(1);
  });

  it("keeps retained V1 queue artifacts parseable under their original digest domain", () => {
    const current = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(factSetCore()),
      policy: loadV9MethodologyPolicy(policyAsset),
    });
    const { responsibilityCounts: _responsibilityCounts, ...summary } = current.summary;
    const entries = current.entries.map(({ responsibility: _responsibility, ...entry }) => entry);
    const core = {
      schemaVersion: 1 as const,
      purpose: current.purpose,
      status: current.status,
      facts: {
        factSetDigest: current.facts.sourceFactSetDigest,
        baseInputGenerationId: current.facts.baseInputGenerationId,
        asOfSec: current.facts.asOfSec,
        compiledAtSec: current.facts.compiledAtSec,
      },
      policy: current.policy,
      summary,
      entries,
    };
    const retained = V9EvidenceGapQueueV1Schema.parse({
      ...core,
      queueDigest: sha256Hex(
        stableJsonStringifyV1({ domain: "safety-score-v9.evidence-gap-queue.v1", queue: core }),
      ),
    });

    expect(parseV9EvidenceGapQueue(retained)).toEqual(retained);
  });

  it("keeps the semantic queue key stable across message edits and rejects digest tampering", () => {
    const policy = loadV9MethodologyPolicy(policyAsset);
    const first = buildV9EvidenceGapQueue({ factSet: compileV9FactSetV3(factSetCore("First message.")), policy });
    const second = buildV9EvidenceGapQueue({ factSet: compileV9FactSetV3(factSetCore("Second message.")), policy });
    expect(second.entries[0]?.queueKey).toBe(first.entries[0]?.queueKey);
    expect(second.queueDigest).not.toBe(first.queueDigest);

    const tampered = structuredClone(first);
    tampered.summary.gapCount = 0;
    expect(() => parseV9EvidenceGapQueue(tampered)).toThrow();

    const validFactSet = compileV9FactSetV3(factSetCore());
    const invalidFactSet = { ...structuredClone(validFactSet), v9FactSetDigest: "f".repeat(64) };
    expect(() => buildV9EvidenceGapQueue({ factSet: invalidFactSet, policy })).toThrow("fact-set digest");
  });

  it("surfaces fact-to-policy ownership drift as reconciliation work", () => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.ownerDomain = "control";
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(1);
    expect(queue.entries[0]).toMatchObject({
      ownerDomain: "evidence",
      factOwnerDomain: "control",
      policyBindingIssues: ["fact-owner-domain-mismatch"],
      action: "reconcile-policy-binding",
    });
  });

  it("surfaces fact-to-policy path-kind drift as reconciliation work", () => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.path = {
      kind: "methodology",
      componentKey: "implementation.launch-date",
    };
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(1);
    expect(queue.entries[0]).toMatchObject({
      ownerDomain: "evidence",
      factOwnerDomain: "evidence",
      path: { kind: "methodology" },
      policyBindingIssues: ["path-kind-not-permitted"],
      action: "reconcile-policy-binding",
    });
  });

  it.each([
    ["registered chain/address", "eip155:1:0x0000000000000000000000000000000000000001", 0.25],
    ["unmatched chain", "unmatched-chain:asset-001", 0.25],
    ["unmatched chain/label/pool", "unmatched-chain-label-pool:asset-001", null],
  ] as const)(
    "admits a %s deployment-control target as a closure path without closing the fact",
    (_label, deploymentKey, materialSupplyShare) => {
      const core = deploymentControlFactSetCore(deploymentKey, materialSupplyShare);
      const queue = buildV9EvidenceGapQueue({
        factSet: compileV9FactSetV3(core),
        policy: loadV9MethodologyPolicy(policyAsset),
      });

      expect(queue.summary.policyBindingMismatchGapCount).toBe(0);
      expect(queue.entries[0]).toMatchObject({
        reasonCode: "unresolved-control-identity",
        ownerDomain: "control",
        factOwnerDomain: "control",
        path: { kind: "deployment-control", deploymentKey },
        policyBindingIssues: [],
      });
      // Admitting the path kind decides where the fact may close, not that it
      // has closed: the row keeps its unresolved observation state and gains no
      // evidence beyond what the unresolved control already carried.
      expect(queue.entries[0]).toMatchObject({
        observationState: "bounded-unknown",
        action: "adjudicate-bounded-unknown",
        evidenceRefIds: [EVIDENCE.evidenceId],
      });
      expect(queue.entries[0]!.materiality).toEqual(
        materialSupplyShare === null
          ? { basis: "unresolved", fractionOfAsset: null }
          : { basis: "deployment-supply-share", fractionOfAsset: materialSupplyShare },
      );
    },
  );

  it("keeps unresolved-control-identity admitting both control path kinds", () => {
    // Owner ruling 2026-07-31. A future policy edit that drops either kind
    // would silently reroute deployment-scoped control gaps back to
    // reconcile-policy-binding, so pin the admitted set.
    const policy = loadV9MethodologyPolicy(policyAsset);
    expect(resolveV9ReasonPolicy(policy, "unresolved-control-identity").reason.pathKinds).toEqual([
      "deployment-control",
      "local-component",
    ]);
  });

  it("surfaces fact-to-policy archetype drift as reconciliation work", () => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.reasonCode = "incomplete-oracle-liquidation-branch";
    core.assets[0]!.gaps[0]!.ownerDomain = "control";
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(1);
    expect(queue.entries[0]).toMatchObject({
      archetype: "algorithmic",
      ownerDomain: "control",
      factOwnerDomain: "control",
      path: { kind: "local-component" },
      policyBindingIssues: ["archetype-not-permitted"],
      action: "reconcile-policy-binding",
    });
  });

  it.each([
    ["missing-pillar-evidence", "evidence"],
    ["missing-access-review", "control"],
  ] as const)("keeps %s %s-owned and locally bound", (reasonCode, ownerDomain) => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.reasonCode = reasonCode;
    core.assets[0]!.gaps[0]!.ownerDomain = ownerDomain;
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(0);
    expect(queue.entries[0]).toMatchObject({
      reasonCode,
      ownerDomain,
      factOwnerDomain: ownerDomain,
      path: { kind: "local-component" },
      policyBindingIssues: [],
      action: "collect-evidence",
    });
  });
});

describe("Safety Score v9 evidence-gap queue CLI", () => {
  it("writes a policy-bound evidence queue and optionally enforces clear", () => {
    const factSet = compileV9FactSetV3(factSetCore());
    const { io, writes } = memoryIo({ facts: factSet, policy: policyAsset });
    const argv = ["--fact-set", "facts", "--policy", "policy", "--output", "queue.json"];
    const queue = runV9EvidenceGapQueueCli(argv, io);
    expect(queue?.status).toBe("work-required");
    expect(queue?.facts).toMatchObject({
      sourceSchemaVersion: 3,
      sourceFactSetDigest: factSet.v9FactSetDigest,
    });
    expect(queue?.entries[0]?.responsibility).toBe("integration-missing");
    expect(parseV9EvidenceGapQueue(JSON.parse(writes.get("queue.json")!))).toEqual(queue);
    expect(() => runV9EvidenceGapQueueCli([...argv, "--require-clear"], io)).toThrow("contains 1 gap");
  });
});
