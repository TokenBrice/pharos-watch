import { describe, expect, it } from "vitest";
import {
  buildSentinelResolutionReport,
  missingDataRegistryFingerprint,
  normalizeLedgerSentinels,
  renderSentinelResolutionMarkdown,
  stringifySentinelResolutionReport,
  sentinelReviewedAtSec,
  type RegistryItem,
} from "../check-safety-score-v9-ledger-sentinels";
import {
  SENTINEL_CHECKER_VERSION,
  type RegistryBinding,
  type SentinelResolutionReport,
} from "../../../scripts/lib/sentinel-resolution-contract";

// The 20261029T1814Z capture clock.
const AS_OF_SEC = Date.UTC(2026, 9, 29, 17, 17, 24) / 1000;
const WORK_TYPES = ["EXIT_RUNTIME_ROUTE", "RESERVE_SLICE", "ORACLE_PROFILE"];

function snapshotBinding(overrides: Record<string, unknown> = {}) {
  return {
    asOfSec: AS_OF_SEC,
    asOfIso: new Date(AS_OF_SEC * 1000).toISOString(),
    candidateId: "candidate-20261029T1814Z",
    publicationGenerationId: "publication-generation-1",
    baseInputGenerationId: "base-input-generation-1",
    factSetDigest: "f".repeat(64),
    resultDigest: "r".repeat(64),
    queueDigest: "q".repeat(64),
    policyId: "safety-score-v9-policy",
    policyDigest: "p".repeat(64),
    evaluationBuildDigest: "e".repeat(64),
    ...overrides,
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "V9G-exit",
    claimGroupId: "EXIT_RUNTIME_ROUTE:alpha",
    workType: "EXIT_RUNTIME_ROUTE",
    status: "open",
    gapId: "alpha:gap:exit-routes",
    reasonCode: "unresolved-exit-output",
    cause: "U",
    path: { kind: "local-component", componentKey: "exit:routes" },
    ...overrides,
  };
}

function scoreProjectionItem(overrides: Record<string, unknown> = {}) {
  return item({
    taskId: "V9S-oracle-2",
    claimGroupId: "ORACLE_PROFILE:alpha",
    workType: "ORACLE_PROFILE",
    gapId: null,
    reasonCode: "missing-oracle-profile",
    cause: null,
    path: { kind: "score-projection", scorePath: "control:alpha:oracle:2" },
    ...overrides,
  });
}

function registry({
  items = [item()],
  ratingStatus = "rated",
  workTypes = WORK_TYPES,
  snapshot = snapshotBinding() as unknown,
  assets = [{ assetId: "alpha", ratingStatus, items }],
  scoreProjectionGaps,
}: {
  items?: unknown[];
  ratingStatus?: string | null;
  workTypes?: string[];
  snapshot?: unknown;
  assets?: Array<{ assetId: string; ratingStatus?: string | null; items: unknown[] }>;
  scoreProjectionGaps?: unknown[];
} = {}) {
  return {
    schemaVersion: 3,
    snapshot: snapshot ?? undefined,
    workTypeDefinitions: Object.fromEntries(workTypes.map((workType) => [workType, { title: workType }])),
    stablecoins: assets.map((asset) => ({
      assetId: asset.assetId,
      currentScore: asset.ratingStatus === null ? null : { ratingStatus: asset.ratingStatus ?? "rated" },
      missingItems: asset.items,
      scoreProjectionGaps: assets.length === 1 && asset.assetId === "alpha" && scoreProjectionGaps
        ? scoreProjectionGaps
        : [],
    })),
  };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    claimGroupId: "EXIT_RUNTIME_ROUTE:alpha",
    decision: "promote",
    reviewedAt: "2026-10-20",
    taskIds: ["V9G-exit"],
    sentinels: [{ doneWhenGapIdAbsent: "alpha:gap:exit-routes", doneWhenScoreReasonAbsent: null }],
    ...overrides,
  };
}

function ledger(decisions: unknown[], allowedDecisions = ["promote", "reject", "defer"]) {
  return { schemaVersion: 1, allowedDecisions, decisions };
}

function reportFor(
  registryValue: unknown,
  ledgerValue: unknown,
  replay?: { value: unknown; path: string },
): SentinelResolutionReport {
  return buildSentinelResolutionReport({
    registry: registryValue,
    ledger: ledgerValue,
    registryPath: "registry.json",
    ledgerPath: "ledger.json",
    ...(replay ? { replay } : {}),
  });
}

function onlyRow(report: SentinelResolutionReport) {
  expect(report.groups).toHaveLength(1);
  return report.groups[0]!;
}

function replayArtifact(overrides: Record<string, unknown> = {}) {
  return {
    pipeline: {
      candidate: {
        candidateId: "candidate-20261029T1814Z",
        asOfSec: AS_OF_SEC,
        publicationGenerationId: "publication-generation-1",
        baseInputGenerationId: "base-input-generation-1",
        factSetDigest: "f".repeat(64),
        resultDigest: "r".repeat(64),
        evaluationBuildDigest: "e".repeat(64),
        policy: { id: "safety-score-v9-policy", semanticDigest: "p".repeat(64) },
        ...overrides,
      },
    },
  };
}

describe("ledger sentinel verdicts", () => {
  it("closes a group whose sentinel gap id is absent while unrelated items remain", () => {
    const report = reportFor(
      registry({
        items: [item({ taskId: "V9G-other", claimGroupId: "RESERVE_SLICE:alpha", gapId: "alpha:gap:reserve-slice" })],
      }),
      ledger([decision()]),
    );
    const row = onlyRow(report);
    expect(row).toMatchObject({
      verdict: "closed",
      reason: "sentinels-absent-group-clear",
      groupState: "no-open-items",
      openItemCount: 0,
      taskIds: { total: 1, open: 0, closed: 1 },
      asOfSec: AS_OF_SEC,
    });
    expect(report.summary.verdictCounts).toMatchObject({ closed: 1 });
    expect(report.summary.closure.derivedFactsClosed).toBe(1);
  });

  it("closes with residual items when no adverse or sibling successor exists", () => {
    const report = reportFor(
      registry({
        items: [
          item({ taskId: "V9G-keep", claimGroupId: "EXIT_RUNTIME_ROUTE:alpha", gapId: "alpha:gap:exit-capacity" }),
        ],
      }),
      ledger([decision()]),
    );
    const row = onlyRow(report);
    expect(row).toMatchObject({
      verdict: "closed",
      reason: "sentinels-absent",
      groupState: "open-items",
      openItemCount: 1,
      taskIds: { total: 1, open: 0, closed: 1 },
    });
  });

  it("keeps the group open while the sentinel gap id is still an open item", () => {
    const report = reportFor(registry(), ledger([decision()]));
    const row = onlyRow(report);
    expect(row).toMatchObject({
      verdict: "still-open",
      reason: "sentinels-still-present",
      sentinels: { machineCheckable: 1, present: 1, absent: 0 },
    });
    expect(row.matches).toEqual([
      {
        kind: "gap",
        identity: "alpha:gap:exit-routes",
        status: "present",
        openItems: 1,
        causes: ["U"],
      },
    ]);
  });

  it("distinguishes a split group from a fully open group", () => {
    const report = reportFor(
      registry(),
      ledger([
        decision({
          sentinels: [
            { doneWhenGapIdAbsent: "alpha:gap:exit-routes" },
            { doneWhenGapIdAbsent: "alpha:gap:exit-capacity" },
          ],
        }),
      ]),
    );
    const row = onlyRow(report);
    expect(row.verdict).toBe("still-open");
    expect(row.reason).toBe("sentinels-partially-absent");
    expect(row.sentinels).toMatchObject({ present: 1, absent: 1 });
  });

  it("never closes a sentinel identity that became a measured-adverse fact", () => {
    const report = reportFor(
      registry({
        items: [item({ cause: "D", reasonCode: "reviewed-possible-access" })],
      }),
      ledger([decision()]),
    );
    const row = onlyRow(report);
    expect(row).toMatchObject({ verdict: "replaced-adversely", reason: "measured-adverse-successor" });
    expect(row.matches[0]).toMatchObject({ status: "adverse", causes: ["D"] });
  });

  it("never closes a sentinel replaced by a sibling gap at the same scope", () => {
    const children = [
      item({ taskId: "V9G-successor", gapId: "alpha:gap:exit-routes:redemption-route", cause: "U" }),
      item({ taskId: "V9G-second", gapId: "alpha:gap:exit-routes:settlement-route", cause: "U" }),
    ];
    for (const items of [children, [...children].reverse()]) {
      const row = onlyRow(reportFor(registry({ items }), ledger([decision()])));
      expect(row).toMatchObject({ verdict: "replaced-adversely", reason: "sibling-sentinel-successor" });
      // Every live child occupies the retired parent's scope, whatever the
      // registry row order: the applier's successor scopes need them all.
      expect(row.matches[0]).toMatchObject({
        status: "successor",
        causes: ["alpha:gap:exit-routes:redemption-route", "alpha:gap:exit-routes:settlement-route"],
      });
    }
  });

  it("never closes a sentinel whose gap re-opened under a rotated route-generation id", () => {
    const generation = (id: string) =>
      `alpha:gap:route:redemption:redemption:${id}:physical-to-usd:alpha:output`;
    const report = reportFor(
      registry({
        items: [
          item({
            taskId: "V9G-regen",
            gapId: generation("975a0051-d448-4e2e-99e2-4775005f7182"),
            reasonCode: "unresolved-exit-output",
          }),
        ],
      }),
      ledger([
        decision({
          sentinels: [
            { doneWhenGapIdAbsent: generation("ebdf5ef5-e7ab-4b14-87dd-f0807db29fa0") },
          ],
        }),
      ]),
    );
    const row = onlyRow(report);
    expect(row).toMatchObject({ verdict: "replaced-adversely", reason: "sibling-sentinel-successor" });
    expect(row.matches[0]).toMatchObject({ status: "successor" });

    // Rotation plus refinement: the parent became a more specific child under the
    // new generation id. Raw ids share no `:`-boundary prefix and the normalized
    // scopes are not equal, but the normalized prefix still holds the scope open.
    const refined = `${generation("975a0051-d448-4e2e-99e2-4775005f7182")}:refined`;
    const refinedReport = reportFor(
      registry({
        items: [item({ taskId: "V9G-regen-child", gapId: refined, reasonCode: "unresolved-exit-output" })],
      }),
      ledger([
        decision({
          sentinels: [{ doneWhenGapIdAbsent: generation("ebdf5ef5-e7ab-4b14-87dd-f0807db29fa0") }],
        }),
      ]),
    );
    expect(onlyRow(refinedReport)).toMatchObject({ verdict: "replaced-adversely", reason: "sibling-sentinel-successor" });
    expect(refinedReport.groups[0]!.matches[0]).toMatchObject({ status: "successor", causes: [refined] });
  });

  it("never closes a score reason that only lost its supplemental task but stays score-visible", () => {
    const sentinel = {
      doneWhenScoreReasonAbsent: { reasonCode: "missing-runtime-route-evidence", path: "exit:missing-runtime-route-evidence:cause:8" },
    };
    // Schema 3 keeps the reason in scoreProjectionGaps after its obligations
    // gained compiled task coverage, so no missingItems row carries it.
    const stillListed = registry({
      items: [],
      scoreProjectionGaps: [
        {
          workType: "EXIT_RUNTIME_ROUTE",
          reasonCode: "missing-runtime-route-evidence",
          path: "exit:missing-runtime-route-evidence:cause:8",
        },
      ],
    });
    expect(onlyRow(reportFor(stillListed, ledger([decision({ sentinels: [sentinel] })])))).toMatchObject({
      verdict: "still-open",
      reason: "sentinels-still-present",
    });

    // The same reason surviving at a different path is a successor, not a closure.
    const movedPath = registry({
      items: [],
      scoreProjectionGaps: [
        {
          workType: "EXIT_RUNTIME_ROUTE",
          reasonCode: "missing-runtime-route-evidence",
          path: "exit:missing-runtime-route-evidence:cause:9",
        },
      ],
    });
    expect(onlyRow(reportFor(movedPath, ledger([decision({ sentinels: [sentinel] })])))).toMatchObject({
      verdict: "replaced-adversely",
      reason: "sibling-sentinel-successor",
    });
  });

  it("never closes a score reason that survived at a different path in the group", () => {
    const report = reportFor(
      registry({ items: [scoreProjectionItem()] }),
      ledger([
        decision({
          claimGroupId: "ORACLE_PROFILE:alpha",
          taskIds: ["V9S-oracle-1"],
          sentinels: [
            {
              doneWhenScoreReasonAbsent: {
                reasonCode: "missing-oracle-profile",
                path: "control:alpha:oracle:1",
              },
            },
          ],
        }),
      ]),
    );
    expect(onlyRow(report)).toMatchObject({
      verdict: "replaced-adversely",
      reason: "sibling-sentinel-successor",
    });
  });

  it("resolves a path-agnostic reason sentinel against this group only", () => {
    const present = reportFor(
      registry({ items: [scoreProjectionItem()] }),
      ledger([
        decision({
          claimGroupId: "ORACLE_PROFILE:alpha",
          sentinels: [{ doneWhenScoreReasonAbsent: "missing-oracle-profile" }],
        }),
      ]),
    );
    expect(onlyRow(present)).toMatchObject({
      verdict: "still-open",
      reason: "sentinels-still-present",
    });
    expect(onlyRow(present).matches[0]?.identity).toBe("missing-oracle-profile|*");

    const absent = reportFor(
      registry({
        assets: [
          { assetId: "alpha", items: [] },
          {
            assetId: "beta",
            items: [
              scoreProjectionItem({
                claimGroupId: "ORACLE_PROFILE:beta",
                taskId: "V9S-beta",
                path: { kind: "score-projection", scorePath: "control:beta:oracle:1" },
              }),
            ],
          },
        ],
      }),
      ledger([
        decision({
          claimGroupId: "ORACLE_PROFILE:alpha",
          sentinels: [{ doneWhenScoreReasonAbsent: "missing-oracle-profile" }],
        }),
      ]),
    );
    expect(onlyRow(absent)).toMatchObject({ verdict: "closed", reason: "sentinels-absent-group-clear" });
  });

  it("never treats narrative-only or missing sentinels as closure evidence", () => {
    const narrative = reportFor(
      registry({ items: [] }),
      ledger([decision({ sentinels: ["awaiting the next production capture"] })]),
    );
    expect(onlyRow(narrative)).toMatchObject({
      verdict: "unverifiable",
      reason: "narrative-only-sentinels",
      sentinels: { narrative: 1, machineCheckable: 0 },
    });
    expect(narrative.summary.verdictCounts.closed).toBe(0);

    const missing = reportFor(registry({ items: [] }), ledger([decision({ sentinels: undefined })]));
    expect(onlyRow(missing)).toMatchObject({ verdict: "unverifiable", reason: "no-sentinels" });
  });

  it("fails closed on a schema-3 registry that omits scoreProjectionGaps", () => {
    // Without the list, a score reason that only lost its supplemental task
    // would read absent and yield a replay-verified closure verdict.
    const truncated = {
      ...registry({ items: [] }),
      stablecoins: registry({ items: [] }).stablecoins.map((asset) => {
        const { scoreProjectionGaps: _omitted, ...rest } = asset as Record<string, unknown>;
        return rest;
      }),
    };
    expect(() => reportFor(truncated, ledger([decision()]))).toThrow(
      /stablecoins\[0\]\.scoreProjectionGaps is required on schema-3 registries/,
    );
  });

  it("blocks closure when a machine-checkable sentinel is accompanied by an uncheckable one", () => {
    const report = reportFor(
      registry({ items: [] }),
      ledger([
        decision({
          sentinels: [
            { doneWhenGapIdAbsent: "alpha:gap:exit-routes" },
            "verify the issuer page by hand",
          ],
        }),
      ]),
    );
    expect(onlyRow(report)).toMatchObject({
      verdict: "unverifiable",
      reason: "uncheckable-sentinel",
      blocks: ["uncheckable-sentinel"],
    });
  });

  it("blocks closure on an unrated (quarantined or pipeline-gap) asset but keeps open verdicts", () => {
    const blocked = reportFor(registry({ items: [], ratingStatus: "pipeline-gap" }), ledger([decision()]));
    expect(onlyRow(blocked)).toMatchObject({ verdict: "unverifiable", reason: "asset-not-rated" });

    const open = reportFor(registry({ ratingStatus: "pipeline-gap" }), ledger([decision()]));
    expect(onlyRow(open)).toMatchObject({ verdict: "still-open", blocks: ["asset-not-rated"] });
  });

  it("blocks closure when the asset or its work type is absent from the registry", () => {
    const absentAsset = reportFor(
      registry({ items: [], assets: [{ assetId: "beta", items: [] }] }),
      ledger([decision()]),
    );
    expect(onlyRow(absentAsset)).toMatchObject({
      verdict: "unverifiable",
      reason: "asset-absent-from-registry",
    });

    const retiredWorkType = reportFor(
      registry({ items: [], workTypes: ["RESERVE_SLICE"] }),
      ledger([decision()]),
    );
    expect(onlyRow(retiredWorkType)).toMatchObject({
      verdict: "unverifiable",
      reason: "work-type-retired",
    });
  });

  it("never judges a decision against a capture older than the decision", () => {
    const report = reportFor(
      registry({ snapshot: snapshotBinding({ asOfSec: AS_OF_SEC - 86_400 }) }),
      ledger([decision({ reviewedAt: "2026-10-29" })]),
    );
    expect(onlyRow(report)).toMatchObject({
      verdict: "unverifiable",
      reason: "capture-predates-decision",
    });
    expect(report.summary.verdictCounts.closed).toBe(0);
  });

  it("marks every row unverifiable when the registry carries no replay binding", () => {
    const report = reportFor(registry({ items: [], snapshot: null }), ledger([decision()]));
    expect(onlyRow(report)).toMatchObject({
      verdict: "unverifiable",
      reason: "registry-binding-unavailable",
      asOfSec: null,
    });
    expect(report.inputs.closureEvidence).toBe("unavailable");
    expect(report.inputs.registry.binding).toBeNull();
    expect(report.inputs.registry.missingDataRegistryFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a supplied replay and rejects a registry from a different replay", () => {
    const verified = reportFor(registry({ items: [] }), ledger([decision()]), {
      value: replayArtifact(),
      path: "accepted.replay.json",
    });
    expect(verified.inputs.closureEvidence).toBe("replay-verified");
    expect(verified.inputs.checkerVersion).toBe(SENTINEL_CHECKER_VERSION);
    expect(verified.inputs.replay).toMatchObject({
      path: "accepted.replay.json",
      candidateId: "candidate-20261029T1814Z",
    });

    expect(() =>
      reportFor(registry({ items: [] }), ledger([decision()]), {
        value: replayArtifact({ publicationGenerationId: "publication-generation-2" }),
        path: "accepted.replay.json",
      }),
    ).toThrow(/does not belong to this registry: publicationGenerationId/);
  });

  it("resolves structured-pending-production admission without promoting unverifiable outcomes", () => {
    const verified = reportFor(
      registry({ items: [] }),
      ledger([decision({ decision: "defer", deferState: "structured-pending-production" })]),
    );
    expect(onlyRow(verified).admission).toBe("verified");

    const failed = reportFor(
      registry(),
      ledger([decision({ decision: "defer", deferState: "structured-pending-production" })]),
    );
    expect(onlyRow(failed)).toMatchObject({ verdict: "still-open", admission: "failed" });

    const unverifiable = reportFor(
      registry({ items: [], snapshot: null }),
      ledger([decision({ decision: "defer", deferState: "structured-pending-production" })]),
    );
    expect(onlyRow(unverifiable).admission).toBe("unverifiable");

    const notApplicable = reportFor(
      registry({ items: [] }),
      ledger([decision({ decision: "defer", deferState: "shadow-collecting" })]),
    );
    expect(onlyRow(notApplicable).admission).toBe("not-applicable");
  });

  it("evaluates the latest appended decision and reports superseded history", () => {
    const report = reportFor(
      registry(),
      ledger([
        decision({ decision: "promote", reviewedAt: "2026-10-01" }),
        decision({
          decision: "defer",
          reviewedAt: "2026-10-25",
          sentinels: [{ doneWhenGapIdAbsent: "alpha:gap:exit-routes" }],
        }),
      ]),
    );
    expect(onlyRow(report)).toMatchObject({ decision: "defer", verdict: "still-open", reviewedAt: "2026-10-25" });
    expect(report.summary).toMatchObject({
      claimGroupCount: 1,
      decisionCount: 2,
      supersededDecisionCount: 1,
    });
  });

  it("derives task closure from the registry rather than the reviewer claim", () => {
    const report = reportFor(
      registry({
        items: [
          item({ taskId: "V9G-keep", gapId: "alpha:gap:exit-capacity" }),
          item({ taskId: "V9G-keep-2", gapId: "alpha:gap:exit-hours" }),
        ],
      }),
      ledger([decision({ taskIds: ["V9G-exit", "V9G-keep"], factsClosed: 99 })]),
    );
    expect(onlyRow(report).taskIds).toEqual({ total: 2, open: 1, closed: 1 });
    expect(report.summary.closure.derivedFactsClosed).toBe(1);
    expect(report.summary.taskIds).toEqual({ evaluated: 2, open: 1, closed: 1 });
  });

  it("rejects decisions outside the ledger's own roster", () => {
    expect(() =>
      reportFor(registry({ items: [] }), ledger([decision({ decision: "approve" })])),
    ).toThrow(/not in the ledger's allowedDecisions roster/);
  });

  it("rejects registry items whose claim group does not belong to their asset", () => {
    expect(() =>
      reportFor(
        registry({ items: [item({ claimGroupId: "EXIT_RUNTIME_ROUTE:beta" })] }),
        ledger([decision()]),
      ),
    ).toThrow(/does not belong to asset alpha/);
  });

  it("is deterministic across repeated builds", () => {
    const first = reportFor(
      registry({
        items: [
          item(),
          item({ taskId: "V9G-second", claimGroupId: "RESERVE_SLICE:alpha", workType: "RESERVE_SLICE" }),
        ],
        assets: [
          { assetId: "beta", items: [] },
          { assetId: "alpha", items: [item()] },
        ],
      }),
      ledger([
        decision(),
        decision({ claimGroupId: "RESERVE_SLICE:alpha", sentinels: [{ doneWhenGapIdAbsent: "alpha:gap:reserve" }] }),
      ]),
    );
    const second = reportFor(
      registry({
        items: [
          item(),
          item({ taskId: "V9G-second", claimGroupId: "RESERVE_SLICE:alpha", workType: "RESERVE_SLICE" }),
        ],
        assets: [
          { assetId: "beta", items: [] },
          { assetId: "alpha", items: [item()] },
        ],
      }),
      ledger([
        decision(),
        decision({ claimGroupId: "RESERVE_SLICE:alpha", sentinels: [{ doneWhenGapIdAbsent: "alpha:gap:reserve" }] }),
      ]),
    );
    expect(stringifySentinelResolutionReport(first)).toBe(stringifySentinelResolutionReport(second));
    expect(first.groups.map((row) => row.claimGroupId)).toEqual([
      "EXIT_RUNTIME_ROUTE:alpha",
      "RESERVE_SLICE:alpha",
    ]);
  });

  it("renders a bounded issue excerpt with its binding and reasons", () => {
    const report = reportFor(
      registry({ items: [] }),
      ledger([decision(), decision({ claimGroupId: "RESERVE_SLICE:alpha", sentinels: ["manual check"] })]),
    );
    const markdown = renderSentinelResolutionMarkdown(report);
    expect(markdown).toContain("# Safety Score v9 ledger sentinel resolutions");
    expect(markdown).toContain(report.inputs.registry.missingDataRegistryFingerprint);
    expect(markdown).toContain("candidate-20261029T1814Z");
    expect(markdown).toContain("closed 1 · still-open 0");
    expect(markdown).toContain("| Claim group | Decision | Reviewed | Open items | Recorded task IDs absent | Reason |");
    expect(markdown).toContain("| narrative-only-sentinels | 1 |");
    expect(markdown).toContain("Nothing in this report appends a ledger decision");
  });
});

describe("sentinel normalization", () => {
  it("separates machine-checkable sentinels from narrative and unresolvable entries", () => {
    expect(
      normalizeLedgerSentinels(
        [
          { doneWhenGapIdAbsent: "alpha:gap:exit-routes", doneWhenScoreReasonAbsent: null },
          { doneWhenScoreReasonAbsent: { reasonCode: "missing-oracle-profile", path: "control:alpha:oracle:1" } },
          { doneWhenScoreReasonAbsent: "missing-oracle-profile" },
          "human prose",
          { reasonCode: "selected-bridge-route-unresolved", path: "control:bridge:route" },
        ],
        "ledger.json:sentinels",
      ),
    ).toEqual([
      { kind: "gap", gapId: "alpha:gap:exit-routes" },
      { kind: "reason", reasonCode: "missing-oracle-profile", path: "control:alpha:oracle:1", anyPath: false },
      { kind: "reason", reasonCode: "missing-oracle-profile", path: null, anyPath: true },
      { kind: "narrative", text: "human prose" },
      expect.objectContaining({ kind: "unresolvable" }),
    ]);
  });

  it("treats a ledger object container as one sentinel", () => {
    expect(normalizeLedgerSentinels({ doneWhenGapIdAbsent: "alpha:gap:exit-routes" }, "ledger.json:sentinels")).toEqual([
      { kind: "gap", gapId: "alpha:gap:exit-routes" },
    ]);
  });

  it("rejects a non-string gap sentinel instead of dropping it", () => {
    expect(() => normalizeLedgerSentinels([{ doneWhenGapIdAbsent: 42 }], "ledger.json:sentinels")).toThrow(
      /doneWhenGapIdAbsent must be a string/,
    );
  });
});

describe("sentinel clocks and fingerprints", () => {
  it("treats a date-only review as starting at UTC midnight", () => {
    expect(sentinelReviewedAtSec("2026-10-20")).toBe(Date.UTC(2026, 9, 20) / 1000);
    expect(sentinelReviewedAtSec("2026-10-20T07:30:00Z")).toBe(Date.UTC(2026, 9, 20, 7, 30) / 1000);
  });

  it("binds the fingerprint to the replay binding and every open item identity", () => {
    const binding = (overrides: Partial<RegistryBinding> = {}): RegistryBinding => ({
      schemaVersion: 2,
      ...snapshotBinding(),
      ...overrides,
    });
    const fingerprintItem = (overrides: Partial<RegistryItem> = {}): RegistryItem => ({
      taskId: "V9G-exit",
      claimGroupId: "EXIT_RUNTIME_ROUTE:alpha",
      workType: "EXIT_RUNTIME_ROUTE",
      gapId: "alpha:gap:exit-routes",
      reasonCode: "unresolved-exit-output",
      cause: "U",
      scoreProjectionKey: null,
      ...overrides,
    });
    const fingerprint = missingDataRegistryFingerprint({
      schemaVersion: 2,
      binding: binding(),
      items: [fingerprintItem()],
    });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      missingDataRegistryFingerprint({
        schemaVersion: 2,
        binding: binding({ asOfSec: AS_OF_SEC + 1 }),
        items: [fingerprintItem()],
      }),
    ).not.toBe(fingerprint);
    expect(
      missingDataRegistryFingerprint({
        schemaVersion: 2,
        binding: binding(),
        items: [fingerprintItem({ cause: "D" })],
      }),
    ).not.toBe(fingerprint);
  });
});
