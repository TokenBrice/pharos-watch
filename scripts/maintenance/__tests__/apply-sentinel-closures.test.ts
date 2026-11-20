import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSentinelResolutionReport,
  stringifySentinelResolutionReport,
} from "../../../worker/scripts/check-safety-score-v9-ledger-sentinels";
import {
  CURATION_LEDGER_DECISION_FIELDS,
  parseCurationLedger,
  serializeCurationLedger,
  sha256Hex,
  type CurationLedger,
} from "../ledger-append";
import {
  SentinelApplyError,
  applySentinelClosures,
  parseSentinelResolutions,
  runApplySentinelClosuresCli,
  type SentinelApplyFailureReason,
} from "../apply-sentinel-closures";
import { SENTINEL_CHECKER_VERSION } from "../../lib/sentinel-resolution-contract";

const CLOCK = 1_793_294_244;
const FIXTURE_GROUP = "RESERVE_SLICE:fixture";
const PRIMARY_TASK = "V9G-aaaaaaaaaaaaaaaa";
const SECONDARY_TASK = "V9G-bbbbbbbbbbbbbbbb";
const TERTIARY_TASK = "V9G-cccccccccccccccc";
const REVIEWED_AT = new Date(CLOCK * 1000).toISOString().slice(0, 10);
const REGISTRY_PATH = "fixture/missing-data-registry.json";
const LEDGER_PATH = "fixture/ledger.json";
const GAP_ONE = { doneWhenGapIdAbsent: "fixture:gap:1", doneWhenScoreReasonAbsent: null };
const GAP_TWO = { doneWhenGapIdAbsent: "fixture:gap:2", doneWhenScoreReasonAbsent: null };

function fixtureDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claimGroupId: FIXTURE_GROUP,
    taskIds: [PRIMARY_TASK, SECONDARY_TASK],
    workType: "RESERVE_SLICE",
    resolutionMode: "agent-curation",
    decision: "defer",
    reviewedAt: "2026-10-01",
    reviewer: "fixture/reviewer",
    evidence: ["fixture source"],
    rationale: "Fixture rationale.",
    changeRefs: [],
    // One sentinel per recorded task row: the one-to-one mapping factsClosed
    // derivation relies on.
    sentinels: [GAP_ONE, GAP_TWO],
    nextReviewTrigger: "Re-review on fresh evidence.",
    factsClosed: 0,
    ...overrides,
  };
}

function makeLedger(decisions: unknown[]): CurationLedger {
  return parseCurationLedger({
    schemaVersion: 1,
    description: "Fixture curation ledger",
    decisionFields: [...CURATION_LEDGER_DECISION_FIELDS],
    allowedDecisions: ["promote", "reject", "defer"],
    decisions,
  });
}

function fixtureItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: SECONDARY_TASK,
    claimGroupId: FIXTURE_GROUP,
    workType: "RESERVE_SLICE",
    gapId: "fixture:gap:2",
    reasonCode: "material-reserve-slice-unstructured",
    cause: null,
    doneWhenScoreReasonAbsent: null,
    ...overrides,
  };
}

function makeRegistry(
  assets: {
    assetId: string;
    ratingStatus?: string | null;
    items?: unknown[];
    projectionGaps?: unknown[];
  }[],
  schemaVersion: 2 | 3 = 2,
): Record<string, unknown> {
  return {
    schemaVersion,
    snapshot: {
      asOfSec: CLOCK,
      candidateId: "safety-score-v9:v1:fixture",
      publicationGenerationId: "generation:fixture",
    },
    workTypeDefinitions: { RESERVE_SLICE: { description: "Fixture work type" } },
    stablecoins: assets.map(({ assetId, ratingStatus = "rated", items = [], projectionGaps = [] }) => ({
      assetId,
      currentScore: { ratingStatus },
      missingItems: items,
      ...(schemaVersion === 3 ? { scoreProjectionGaps: projectionGaps } : {}),
    })),
  };
}

function fixtureReplay(): unknown {
  return {
    pipeline: {
      candidate: {
        candidateId: "safety-score-v9:v1:fixture",
        asOfSec: CLOCK,
        publicationGenerationId: "generation:fixture",
      },
    },
  };
}

function registryBytes(registry: Record<string, unknown>): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

/**
 * Build the artifact with the sweep checker itself, so the applier is always
 * exercised against the contract the checker actually emits.
 */
function checkerArtifact(input: {
  ledger: CurationLedger;
  registry: Record<string, unknown>;
  replay?: boolean;
}): { artifact: Record<string, unknown>; registrySha256: string } {
  const registrySha256 = sha256Hex(registryBytes(input.registry));
  const report = buildSentinelResolutionReport({
    registry: input.registry,
    registrySha256,
    ledger: input.ledger,
    registryPath: REGISTRY_PATH,
    ledgerPath: LEDGER_PATH,
    ...(input.replay === false ? {} : { replay: { value: fixtureReplay(), path: "fixture/replay.json" } }),
  });
  return {
    artifact: JSON.parse(stringifySentinelResolutionReport(report)) as Record<string, unknown>,
    registrySha256,
  };
}

function checkerRow(artifact: Record<string, unknown>, index = 0): Record<string, unknown> {
  const groups = artifact.groups as Record<string, unknown>[];
  return groups[index]!;
}

function apply(
  ledger: CurationLedger,
  registry: Record<string, unknown>,
  artifact: unknown,
  registryFingerprint?: string,
) {
  return applySentinelClosures({
    ledger,
    registry,
    resolutions: artifact,
    registryFingerprint: registryFingerprint ?? sha256Hex(registryBytes(registry)),
  });
}

function expectApplyReason(run: () => unknown, reason: SentinelApplyFailureReason): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SentinelApplyError);
    expect((error as SentinelApplyError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected a SentinelApplyError with reason ${reason}`);
}

const temporaryDirectories: string[] = [];

function temporaryFile(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-sentinel-apply-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("sentinel closure applier", () => {
  it("consumes the checker's emitted artifact and books a closed verdict", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const { artifact, registrySha256 } = checkerArtifact({ ledger, registry });

    // The artifact is the checker's real shape: groups[], verdict/admission axes,
    // per-row decision index, and the registry file digest under inputs.
    expect(checkerRow(artifact)).toMatchObject({
      claimGroupId: FIXTURE_GROUP,
      verdict: "closed",
      reason: "sentinels-absent-group-clear",
      admission: "not-applicable",
      ledgerDecisionIndex: 0,
      openItemCount: 0,
    });
    expect((artifact.inputs as Record<string, unknown>).closureEvidence).toBe("replay-verified");

    const parsed = parseSentinelResolutions(artifact);
    expect(parsed).toMatchObject({
      registrySha256,
      captureClockSec: CLOCK,
      ledgerDecisionCount: 1,
    });

    const result = apply(ledger, registry, artifact);
    expect(result.skipped).toEqual([]);
    expect(result.booked).toHaveLength(1);
    const record = result.booked[0]!.decisionRecord;
    expect(record).toMatchObject({
      claimGroupId: FIXTURE_GROUP,
      decision: "promote",
      taskIds: [],
      sentinels: [],
      factsClosed: 2,
      reviewer: `sentinel-sweep/${CLOCK}`,
      reviewedAt: REVIEWED_AT,
    });
    expect(record.evidence[0]).toContain(`registry ${registrySha256} @ ${CLOCK}`);
    expect(record.evidence[0]).toContain(`missing-data identity ${parsed.identityFingerprint}`);
    expect(record.evidence[0]).toContain("closed verdict; factsClosed 2 re-derived");
    expect(result.ledger.decisions).toHaveLength(2);
    expect(result.ledger.decisions[0]).toEqual(ledger.decisions[0]);
  });

  it("books a closed verdict from a schema-3 missing-data registry", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture" }], 3);
    const { artifact } = checkerArtifact({ ledger, registry });

    const result = apply(ledger, registry, artifact);
    expect(result.skipped).toEqual([]);
    expect(result.booked).toHaveLength(1);
    expect(result.booked[0]!.decisionRecord.factsClosed).toBe(2);
  });

  it("refuses registry-snapshot artifacts that no replay verified", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const { artifact } = checkerArtifact({ ledger, registry, replay: false });
    expect((artifact.inputs as Record<string, unknown>).closureEvidence).toBe("registry-snapshot");

    expectApplyReason(() => parseSentinelResolutions(artifact), "closure-evidence-insufficient");
    expectApplyReason(() => apply(ledger, registry, artifact), "closure-evidence-insufficient");
  });

  it("refuses archived checker artifacts that predate the current checker version", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect((artifact.inputs as Record<string, unknown>).checkerVersion).toBe(SENTINEL_CHECKER_VERSION);

    // The archived November 17 shape: replay-verified, right registry, but no
    // checker version stamp — its verdicts predate the fixed closure rules.
    const { checkerVersion: _omitted, ...archivedInputs } = artifact.inputs as Record<string, unknown>;
    const archived = { ...artifact, inputs: archivedInputs };
    expectApplyReason(() => parseSentinelResolutions(archived), "checker-version-mismatch");
    expectApplyReason(() => apply(ledger, registry, archived), "checker-version-mismatch");
  });

  it("skips structured-pending-production admission failures as a wait state, never a reject", () => {
    const openRegistry = makeRegistry([{ assetId: "fixture", items: [fixtureItem({ gapId: "fixture:gap:1", taskId: PRIMARY_TASK })] }]);
    const spp = fixtureDecision({ deferState: "structured-pending-production" });
    const ledger = makeLedger([spp]);
    const stillOpen = checkerArtifact({ ledger, registry: openRegistry });
    expect(checkerRow(stillOpen.artifact)).toMatchObject({ verdict: "still-open", admission: "failed" });

    const blocked = apply(ledger, openRegistry, stillOpen.artifact);
    expect(blocked.booked).toEqual([]);
    expect(blocked.skipped).toHaveLength(1);
    expect(blocked.skipped[0]).toMatchObject({ reason: "spp-admission-failed", verdict: "still-open" });
    expect(blocked.ledger.decisions).toHaveLength(1);

    // The split shape (one sentinel absent, one open) is still an SPP admission
    // failure, so it must wait rather than book a partial promote.
    const splitSpp = makeLedger([
      fixtureDecision({
        deferState: "structured-pending-production",
        sentinels: [
          { doneWhenGapIdAbsent: "fixture:gap:1", doneWhenScoreReasonAbsent: null },
          { doneWhenGapIdAbsent: "fixture:gap:2" },
        ],
      }),
    ]);
    const splitArtifact = checkerArtifact({ ledger: splitSpp, registry: openRegistry });
    expect(checkerRow(splitArtifact.artifact)).toMatchObject({
      verdict: "still-open",
      reason: "sentinels-partially-absent",
      admission: "failed",
    });
    const splitBlocked = apply(splitSpp, openRegistry, splitArtifact.artifact);
    expect(splitBlocked.booked).toEqual([]);
    expect(splitBlocked.skipped[0]!.reason).toBe("spp-admission-failed");

    // A verified admission on a closed SPP decision does book.
    const cleanSpp = makeLedger([fixtureDecision({ deferState: "structured-pending-production" })]);
    const verified = checkerArtifact({ ledger: cleanSpp, registry: makeRegistry([{ assetId: "fixture" }]) });
    expect(checkerRow(verified.artifact)).toMatchObject({ verdict: "closed", admission: "verified" });
    const admitted = apply(cleanSpp, makeRegistry([{ assetId: "fixture" }]), verified.artifact);
    expect(admitted.booked).toHaveLength(1);
    expect(admitted.booked[0]!.decisionRecord.decision).toBe("promote");
  });

  it("books a still-open split as a partial promote that carries the outstanding sentinels", () => {
    const ledger = makeLedger([
      fixtureDecision({
        sentinels: [
          { doneWhenGapIdAbsent: "fixture:gap:1", doneWhenScoreReasonAbsent: null },
          { doneWhenGapIdAbsent: "fixture:gap:2" },
        ],
      }),
    ]);
    const registry = makeRegistry([{ assetId: "fixture", items: [fixtureItem()] }]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact)).toMatchObject({
      verdict: "still-open",
      reason: "sentinels-partially-absent",
      admission: "not-applicable",
      openItemCount: 1,
    });

    const result = apply(ledger, registry, artifact);
    expect(result.skipped).toEqual([]);
    expect(result.booked).toHaveLength(1);
    expect(result.booked[0]!.decisionRecord).toMatchObject({
      decision: "promote",
      taskIds: [SECONDARY_TASK],
      factsClosed: 1,
      sentinels: [{ doneWhenGapIdAbsent: "fixture:gap:2", doneWhenScoreReasonAbsent: null }],
    });
  });

  it("skips a closure whose recorded task stays open on an unmapped obligation", () => {
    // One recorded task, one absent sentinel, counts and identities agree — but
    // the task is still open on a different gap. Booking would drop the only
    // sentinel while factsClosed claims a closed fact.
    const ledger = makeLedger([fixtureDecision({ taskIds: [PRIMARY_TASK], sentinels: [GAP_ONE] })]);
    const registry = makeRegistry([
      { assetId: "fixture", items: [fixtureItem({ taskId: PRIMARY_TASK, gapId: "fixture:gap:2" })] },
    ]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact)).toMatchObject({ verdict: "closed", reason: "sentinels-absent" });

    const result = apply(ledger, registry, artifact);
    expect(result.booked).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: "ambiguous-task-mapping", verdict: "closed" });
  });

  it("carries a projection-backed split on the projection's single covering task", () => {
    // Schema-3 shape: the projection lost its supplemental task row, so only
    // scoreProjectionGaps still lists it; without the projection's
    // coveredByTaskIds the booked split carries its sentinel with zero task
    // rows and the next sweep dead-ends on no-derived-closure.
    const projection = {
      doneWhenScoreReasonAbsent: { reasonCode: "material-reserve-slice-unstructured", path: "reserveComposition" },
    };
    const compiled = { taskId: TERTIARY_TASK, gapId: "fixture:gap:compiled", reasonCode: "compiled-cause" };
    const ledger = makeLedger([fixtureDecision({ sentinels: [GAP_ONE, projection] })]);
    const registry = makeRegistry(
      [
        {
          assetId: "fixture",
          items: [fixtureItem(compiled)],
          projectionGaps: [
            {
              reasonCode: "material-reserve-slice-unstructured",
              workType: "RESERVE_SLICE",
              path: "reserveComposition",
              coveredByTaskIds: [TERTIARY_TASK],
            },
          ],
        },
      ],
      3,
    );
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact)).toMatchObject({ verdict: "still-open", reason: "sentinels-partially-absent" });

    const result = apply(ledger, registry, artifact);
    expect(result.skipped).toEqual([]);
    expect(result.booked[0]!.decisionRecord).toMatchObject({
      factsClosed: 1,
      taskIds: [TERTIARY_TASK],
      sentinels: [projection],
    });

    const cleared = makeRegistry([{ assetId: "fixture" }], 3);
    const second = checkerArtifact({ ledger: result.ledger, registry: cleared });
    expect(checkerRow(second.artifact)).toMatchObject({ verdict: "closed" });
    const closed = apply(result.ledger, cleared, second.artifact);
    expect(closed.skipped).toEqual([]);
    expect(closed.booked[0]!.decisionRecord).toMatchObject({ decision: "promote", factsClosed: 1, taskIds: [] });

    // Two covering tasks cannot establish the carried mapping, so the split skips.
    const ambiguous = makeRegistry(
      [
        {
          assetId: "fixture",
          items: [fixtureItem(compiled), fixtureItem({ ...compiled, taskId: SECONDARY_TASK, gapId: "fixture:gap:compiled2" })],
          projectionGaps: [
            {
              reasonCode: "material-reserve-slice-unstructured",
              workType: "RESERVE_SLICE",
              path: "reserveComposition",
              coveredByTaskIds: [TERTIARY_TASK, SECONDARY_TASK],
            },
          ],
        },
      ],
      3,
    );
    const refused = apply(ledger, ambiguous, checkerArtifact({ ledger, registry: ambiguous }).artifact);
    expect(refused.booked).toEqual([]);
    expect(refused.skipped[0]!.reason).toBe("ambiguous-task-mapping");

    // A successor reason that moved paths maps through the successor
    // projection's single covering task, not the retired path.
    const movedSentinel = {
      doneWhenScoreReasonAbsent: { reasonCode: "material-reserve-slice-unstructured", path: "reserveCompositionRetired" },
    };
    const movedLedger = makeLedger([
      fixtureDecision({ taskIds: [PRIMARY_TASK, SECONDARY_TASK, TERTIARY_TASK], sentinels: [GAP_ONE, GAP_TWO, movedSentinel] }),
    ]);
    const movedRegistry = makeRegistry(
      [
        {
          assetId: "fixture",
          items: [fixtureItem(compiled), fixtureItem()],
          projectionGaps: [
            {
              reasonCode: "material-reserve-slice-unstructured",
              workType: "RESERVE_SLICE",
              path: "reserveCompositionMoved",
              coveredByTaskIds: [TERTIARY_TASK],
            },
          ],
        },
      ],
      3,
    );
    const moved = apply(
      movedLedger,
      movedRegistry,
      checkerArtifact({ ledger: movedLedger, registry: movedRegistry }).artifact,
    );
    expect(moved.skipped).toEqual([]);
    expect(moved.booked[0]!.decisionRecord).toMatchObject({
      factsClosed: 1,
      taskIds: [SECONDARY_TASK, TERTIARY_TASK],
      sentinels: [GAP_TWO, movedSentinel],
    });
  });

  it("skips a split whose successor scopes share one task and one reason spans two", () => {
    // Two retired child gaps share a single successor task while a
    // path-agnostic reason matches two other rows: three carried sentinels,
    // three live tasks, and no one-to-one assignment — counts alone must not
    // book it, and successor scopes must match per sentinel.
    const childOne = "fixture:gap:route:a:field";
    const childTwo = "fixture:gap:route:b:field";
    const reasonRow = (taskId: string, scorePath: string) =>
      fixtureItem({
        taskId,
        gapId: null,
        reasonCode: "shared-reason-code",
        path: { kind: "score-projection", scorePath },
      });
    const ledger = makeLedger([
      fixtureDecision({
        taskIds: [PRIMARY_TASK, SECONDARY_TASK, TERTIARY_TASK, "V9G-dddddddddddddddd"],
        sentinels: [
          { doneWhenGapIdAbsent: childOne, doneWhenScoreReasonAbsent: null },
          { doneWhenGapIdAbsent: childTwo, doneWhenScoreReasonAbsent: null },
          { doneWhenScoreReasonAbsent: "shared-reason-code" },
          GAP_ONE,
        ],
      }),
    ]);
    const registry = makeRegistry([
      {
        assetId: "fixture",
        items: [
          fixtureItem({ taskId: "V9G-successor", gapId: "fixture:gap:route", reasonCode: "route-cause" }),
          reasonRow("V9G-reasonone", "alpha"),
          reasonRow("V9G-reasontwo", "beta"),
        ],
      },
    ]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact).matches).toEqual([
      expect.objectContaining({ identity: childOne, status: "successor" }),
      expect.objectContaining({ identity: childTwo, status: "successor" }),
      expect.objectContaining({ identity: "shared-reason-code|*", status: "present" }),
      expect.objectContaining({ identity: "fixture:gap:1", status: "absent" }),
    ]);

    const result = apply(ledger, registry, artifact);
    expect(result.booked).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: "ambiguous-task-mapping", verdict: "still-open" });
  });

  it("carries a split on a covering task the decision already records", () => {
    // The projection's single covering task is not a replacement id here: the
    // decision recorded it earlier, so the split must accept it through the
    // same projection mapping instead of skipping as ambiguous.
    const projection = {
      doneWhenScoreReasonAbsent: { reasonCode: "material-reserve-slice-unstructured", path: "reserveComposition" },
    };
    const ledger = makeLedger([
      fixtureDecision({ taskIds: [PRIMARY_TASK, TERTIARY_TASK], sentinels: [GAP_ONE, projection] }),
    ]);
    const registry = makeRegistry(
      [
        {
          assetId: "fixture",
          items: [fixtureItem({ taskId: TERTIARY_TASK, gapId: "fixture:gap:compiled", reasonCode: "compiled-cause" })],
          projectionGaps: [
            {
              reasonCode: "material-reserve-slice-unstructured",
              workType: "RESERVE_SLICE",
              path: "reserveComposition",
              coveredByTaskIds: [TERTIARY_TASK],
            },
          ],
        },
      ],
      3,
    );
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact)).toMatchObject({ verdict: "still-open", reason: "sentinels-partially-absent" });

    const result = apply(ledger, registry, artifact);
    expect(result.skipped).toEqual([]);
    expect(result.booked[0]!.decisionRecord).toMatchObject({
      factsClosed: 1,
      taskIds: [TERTIARY_TASK],
      sentinels: [projection],
    });
  });

  it("resolves a projection's covering task across work types and carries it on later sweeps", () => {
    // 341 archived-registry projections are covered by a single task row that
    // lives in another work type's group on the same asset: the covering-task
    // lookup and the carried-ID filter are asset-scoped, never group-scoped.
    const projection = {
      doneWhenScoreReasonAbsent: { reasonCode: "material-reserve-slice-unstructured", path: "reserveComposition" },
    };
    const foreignTask = "V9G-foreignworktype";
    const foreignItem = fixtureItem({
      taskId: foreignTask,
      claimGroupId: "DEPLOYMENT_CONTROLS:fixture",
      workType: "DEPLOYMENT_CONTROLS",
      gapId: "fixture:gap:controls",
      reasonCode: "compiled-cause",
    });
    const coveredProjection = {
      reasonCode: "material-reserve-slice-unstructured",
      workType: "RESERVE_SLICE",
      path: "reserveComposition",
      coveredByTaskIds: [foreignTask],
    };
    const ledger = makeLedger([
      fixtureDecision({
        taskIds: [PRIMARY_TASK, SECONDARY_TASK, TERTIARY_TASK],
        sentinels: [GAP_ONE, GAP_TWO, projection],
      }),
    ]);
    const sweepOne = makeRegistry(
      [{ assetId: "fixture", items: [fixtureItem(), foreignItem], projectionGaps: [coveredProjection] }],
      3,
    );
    const first = apply(ledger, sweepOne, checkerArtifact({ ledger, registry: sweepOne }).artifact);
    expect(first.skipped).toEqual([]);
    expect(first.booked[0]!.decisionRecord).toMatchObject({
      factsClosed: 1,
      taskIds: [SECONDARY_TASK, foreignTask],
      sentinels: [GAP_TWO, projection],
    });

    // Later sweep: both carried sentinels cleared but the foreign covering task
    // is still live on the asset, so the decision's carried row cannot close.
    const stillLive = makeRegistry([{ assetId: "fixture", items: [foreignItem] }], 3);
    const stillLiveArtifact = checkerArtifact({ ledger: first.ledger, registry: stillLive });
    expect(checkerRow(stillLiveArtifact.artifact)).toMatchObject({ verdict: "closed" });
    const second = apply(first.ledger, stillLive, stillLiveArtifact.artifact);
    expect(second.booked).toEqual([]);
    expect(second.skipped[0]).toMatchObject({ reason: "ambiguous-task-mapping" });

    // Once the foreign task retires, the group closes instead of dead-ending.
    const cleared = makeRegistry([{ assetId: "fixture" }], 3);
    const third = apply(first.ledger, cleared, checkerArtifact({ ledger: first.ledger, registry: cleared }).artifact);
    expect(third.skipped).toEqual([]);
    expect(third.booked[0]!.decisionRecord).toMatchObject({ factsClosed: 2, taskIds: [] });
  });

  it("skips partial promotions on assets the checker holds not rated", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture", ratingStatus: "not-rated", items: [fixtureItem()] }]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact)).toMatchObject({ verdict: "still-open", reason: "sentinels-partially-absent" });

    const result = apply(ledger, registry, artifact);
    expect(result.booked).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: "asset-not-rated" });
  });

  it("derives factsClosed from verified-absent sentinels and carries rotated task ids forward", () => {
    // Wyoming shape: the open sentinel's gap persists under a re-issued task id,
    // so raw task-id absence must not count as a closed fact.
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture", items: [fixtureItem({ taskId: "V9G-rotated" })] }]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact)).toMatchObject({ verdict: "still-open", reason: "sentinels-partially-absent" });

    const result = apply(ledger, registry, artifact);
    expect(result.skipped).toEqual([]);
    expect(result.booked[0]!.decisionRecord).toMatchObject({
      factsClosed: 1,
      taskIds: ["V9G-rotated"],
      sentinels: [GAP_TWO],
    });
    expect(result.booked[0]!.decisionRecord.evidence[0]).toContain(
      "1 of 2 recorded task rows map to verified-absent sentinels",
    );
  });

  it("matches the checker's path-agnostic identity for a reason object without a path", () => {
    // The checker emits `reason|*` for `{reasonCode, path: null}`; the applier
    // must look up the same identity or a valid closure skips as still-open.
    const ledger = makeLedger([
      fixtureDecision({
        taskIds: [SECONDARY_TASK],
        sentinels: [{ doneWhenScoreReasonAbsent: { reasonCode: "material-reserve-slice-unstructured", path: null } }],
      }),
    ]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact)).toMatchObject({ verdict: "closed" });

    const result = apply(ledger, registry, artifact);
    expect(result.skipped).toEqual([]);
    expect(result.booked).toHaveLength(1);
    expect(result.booked[0]!.decisionRecord).toMatchObject({ factsClosed: 1, taskIds: [] });

    // Schema-2 split: the same path-agnostic reason keeps a live supplemental
    // task at a named path open, so the split carries it instead of skipping
    // as ambiguous.
    const pathless = { doneWhenScoreReasonAbsent: { reasonCode: "material-reserve-slice-unstructured", path: null } };
    const openLedger = makeLedger([fixtureDecision({ sentinels: [GAP_ONE, pathless] })]);
    const openRegistry = makeRegistry([
      {
        assetId: "fixture",
        items: [
          fixtureItem({
            taskId: SECONDARY_TASK,
            gapId: null,
            reasonCode: "material-reserve-slice-unstructured",
            path: { kind: "score-projection", scorePath: "reserveComposition" },
            doneWhenScoreReasonAbsent: { reasonCode: "material-reserve-slice-unstructured", path: "reserveComposition" },
          }),
        ],
      },
    ]);
    const open = apply(openLedger, openRegistry, checkerArtifact({ ledger: openLedger, registry: openRegistry }).artifact);
    expect(open.skipped).toEqual([]);
    expect(open.booked[0]!.decisionRecord).toMatchObject({
      factsClosed: 1,
      taskIds: [SECONDARY_TASK],
      sentinels: [pathless],
    });
  });

  it("skips scoped closures whose task rows cannot be mapped one-to-one to sentinels", () => {
    // JPYT shape: two recorded task rows, one scoped sentinel, checker closed.
    const ledger = makeLedger([fixtureDecision({ sentinels: [GAP_ONE] })]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact).verdict).toBe("closed");

    const result = apply(ledger, registry, artifact);
    expect(result.booked).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: "ambiguous-task-mapping", verdict: "closed" });

    // Equal counts are not a mapping: two task rows with two copies of the same
    // absent sentinel would book two facts closed while a third obligation
    // (gap 3) stays open, so the duplicate identity stays ambiguous.
    const dupLedger = makeLedger([fixtureDecision({ sentinels: [GAP_ONE, GAP_ONE] })]);
    const dupRegistry = makeRegistry([
      { assetId: "fixture", items: [fixtureItem({ gapId: "fixture:gap:3", taskId: TERTIARY_TASK })] },
    ]);
    const dupArtifact = checkerArtifact({ ledger: dupLedger, registry: dupRegistry });
    expect(checkerRow(dupArtifact.artifact)).toMatchObject({ verdict: "closed", reason: "sentinels-absent" });
    const dupResult = apply(dupLedger, dupRegistry, dupArtifact.artifact);
    expect(dupResult.booked).toEqual([]);
    expect(dupResult.skipped[0]).toMatchObject({ reason: "ambiguous-task-mapping", verdict: "closed" });
  });

  it("requires a checker-confirmed absent match for a split and preserves successor obligations", () => {
    const concentrationGap = "fixture:gap:reserve:slice:obligorConcentration";
    const ledger = makeLedger([
      fixtureDecision({
        taskIds: [PRIMARY_TASK, SECONDARY_TASK, TERTIARY_TASK],
        sentinels: [GAP_ONE, { doneWhenGapIdAbsent: concentrationGap, doneWhenScoreReasonAbsent: null }, GAP_TWO],
      }),
    ]);
    // The concentration gap's parent scope re-opened (checker: sibling
    // successor) beside a still-present gap; the split must keep both carried.
    const registry = makeRegistry([
      {
        assetId: "fixture",
        items: [fixtureItem({ taskId: "V9G-successor", gapId: "fixture:gap:reserve:slice" }), fixtureItem()],
      },
    ]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact)).toMatchObject({ verdict: "still-open", reason: "sentinels-partially-absent" });
    expect(checkerRow(artifact).matches).toEqual([
      expect.objectContaining({ identity: "fixture:gap:1", status: "absent" }),
      expect.objectContaining({ identity: concentrationGap, status: "successor" }),
      expect.objectContaining({ identity: "fixture:gap:2", status: "present" }),
    ]);

    const result = apply(ledger, registry, artifact);
    expect(result.skipped).toEqual([]);
    expect(result.booked[0]!.decisionRecord).toMatchObject({
      factsClosed: 1,
      // The successor obligation's current task id rides along, keeping the
      // booked split at one task row per carried sentinel.
      taskIds: [SECONDARY_TASK, "V9G-successor"],
      sentinels: [
        { doneWhenGapIdAbsent: concentrationGap, doneWhenScoreReasonAbsent: null },
        GAP_TWO,
      ],
    });

    // Second sweep: both carried gaps clear, so the split must close instead of
    // dead-ending on ambiguous-task-mapping.
    const clearedRegistry = makeRegistry([{ assetId: "fixture" }]);
    const secondSweep = checkerArtifact({ ledger: result.ledger, registry: clearedRegistry });
    expect(checkerRow(secondSweep.artifact)).toMatchObject({ verdict: "closed" });
    const closed = apply(result.ledger, clearedRegistry, secondSweep.artifact);
    expect(closed.skipped).toEqual([]);
    expect(closed.booked).toHaveLength(1);
    expect(closed.booked[0]!.decisionRecord).toMatchObject({
      decision: "promote",
      factsClosed: 2,
      taskIds: [],
    });

    // Infinifi shape: no checker-confirmed absent match, only successors and
    // present sentinels, never books.
    const noAbsent = makeLedger([
      fixtureDecision({
        sentinels: [{ doneWhenGapIdAbsent: concentrationGap, doneWhenScoreReasonAbsent: null }, GAP_TWO],
      }),
    ]);
    const noAbsentRegistry = makeRegistry([
      {
        assetId: "fixture",
        items: [fixtureItem({ taskId: "V9G-successor", gapId: "fixture:gap:reserve:slice" }), fixtureItem()],
      },
    ]);
    const noAbsentArtifact = checkerArtifact({ ledger: noAbsent, registry: noAbsentRegistry });
    expect(checkerRow(noAbsentArtifact.artifact)).toMatchObject({
      verdict: "still-open",
      reason: "sentinels-partially-absent",
    });
    const refused = apply(noAbsent, noAbsentRegistry, noAbsentArtifact.artifact);
    expect(refused.booked).toEqual([]);
    expect(refused.skipped[0]!.reason).toBe("sentinel-still-open");
  });

  it("selects the latest decision by reviewedAt like the checker, not by append order", () => {
    // A backdated defer appended last must not shadow the newer decision the
    // checker evaluated: the applier uses the same max-reviewedAt selection.
    const ledger = makeLedger([
      fixtureDecision({ reviewedAt: "2026-10-05", evidence: ["newer source"] }),
      fixtureDecision({ reviewedAt: "2026-10-01", taskIds: [PRIMARY_TASK], evidence: ["backdated source"] }),
    ]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact)).toMatchObject({ ledgerDecisionIndex: 0, verdict: "closed" });

    const result = apply(ledger, registry, artifact);
    expect(result.skipped).toEqual([]);
    expect(result.booked).toHaveLength(1);
    expect(result.booked[0]!.decisionRecord).toMatchObject({
      factsClosed: 2,
      reviewer: `sentinel-sweep/${CLOCK}`,
    });
  });

  it("is idempotent across repeat runs and refuses a stale ledger basis", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const { artifact } = checkerArtifact({ ledger, registry });

    const first = apply(ledger, registry, artifact);
    expect(first.booked).toHaveLength(1);

    const second = apply(first.ledger, registry, artifact);
    expect(second.booked).toEqual([]);
    expect(second.skipped.map((entry) => entry.reason)).toEqual(["already-applied"]);
    expect(second.ledger.decisions).toHaveLength(first.ledger.decisions.length);

    const grown = makeLedger([
      fixtureDecision(),
      fixtureDecision({ claimGroupId: "MINT_AUTHORITY:another", workType: "MINT_AUTHORITY", taskIds: [] }),
    ]);
    const stale = apply(grown, registry, artifact);
    expect(stale.booked).toEqual([]);
    expect(stale.skipped[0]!.reason).toBe("stale-ledger-basis");
  });

  it("re-verifies the artifact against the registry instead of trusting its verdicts", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const openRegistry = makeRegistry([
      { assetId: "fixture", items: [fixtureItem({ gapId: "fixture:gap:1", taskId: PRIMARY_TASK })] },
    ]);
    const stillOpen = checkerArtifact({ ledger, registry: openRegistry });
    expect(checkerRow(stillOpen.artifact).verdict).toBe("still-open");

    // A tampered artifact that claims a closure cannot book against rows that
    // still hold its sentinel.
    const tampered = {
      ...stillOpen.artifact,
      groups: [{ ...checkerRow(stillOpen.artifact), verdict: "closed", reason: "sentinels-absent" }],
    };
    const refused = apply(ledger, openRegistry, tampered);
    expect(refused.booked).toEqual([]);
    expect(refused.skipped[0]!.reason).toBe("sentinel-still-open");

    // The same holds when the ledger sentinel is prose: no prose closure.
    const proseLedger = makeLedger([fixtureDecision({ sentinels: ["watch the next filing"] })]);
    const proseArtifact = checkerArtifact({ ledger: proseLedger, registry: makeRegistry([{ assetId: "fixture" }]) });
    const proseTampered = {
      ...proseArtifact.artifact,
      groups: [{ ...checkerRow(proseArtifact.artifact), verdict: "closed", reason: "sentinels-absent" }],
    };
    const prose = apply(proseLedger, makeRegistry([{ assetId: "fixture" }]), proseTampered);
    expect(prose.booked).toEqual([]);
    expect(prose.skipped[0]!.reason).toBe("non-machine-sentinel");
  });

  it("refuses a claimed reason absence the registry's scoreProjectionGaps still lists", () => {
    // A current-version artifact that wrongly marks a projection-only reason
    // absent must not book: task rows alone cannot prove absence while the
    // schema-3 registry still projects the reason (exact pair, path-agnostic,
    // or the reason surviving at another path — a successor, never closed).
    const cases = [
      {
        sentinel: { doneWhenScoreReasonAbsent: { reasonCode: "material-reserve-slice-unstructured", path: "reserveComposition" } },
        projectionPath: "reserveComposition",
        openVerdict: "still-open",
        openReason: "sentinels-still-present",
      },
      {
        sentinel: { doneWhenScoreReasonAbsent: { reasonCode: "material-reserve-slice-unstructured", path: null } },
        projectionPath: "reserveComposition",
        openVerdict: "still-open",
        openReason: "sentinels-still-present",
      },
      {
        sentinel: { doneWhenScoreReasonAbsent: { reasonCode: "material-reserve-slice-unstructured", path: "reserveCompositionRetired" } },
        projectionPath: "reserveCompositionMoved",
        openVerdict: "replaced-adversely",
        openReason: "sibling-sentinel-successor",
      },
    ];
    for (const { sentinel, projectionPath, openVerdict, openReason } of cases) {
      const ledger = makeLedger([fixtureDecision({ taskIds: [PRIMARY_TASK], sentinels: [sentinel] })]);
      const registry = makeRegistry(
        [
          {
            assetId: "fixture",
            projectionGaps: [
              {
                reasonCode: "material-reserve-slice-unstructured",
                workType: "RESERVE_SLICE",
                path: projectionPath,
                coveredByTaskIds: [TERTIARY_TASK],
              },
            ],
          },
        ],
        3,
      );
      const { artifact } = checkerArtifact({ ledger, registry });
      expect(checkerRow(artifact)).toMatchObject({ verdict: openVerdict, reason: openReason });
      const tampered = {
        ...artifact,
        groups: [
          {
            ...checkerRow(artifact),
            verdict: "closed",
            reason: "sentinels-absent",
            matches: (checkerRow(artifact).matches as { status: string }[]).map((match) => ({
              ...match,
              status: "absent",
            })),
          },
        ],
      };
      const refused = apply(ledger, registry, tampered);
      expect(refused.booked).toEqual([]);
      expect(refused.skipped[0]!.reason).toBe("sentinel-still-open");
      expect(refused.skipped[0]!.detail).toContain("scoreProjectionGaps");
    }
  });

  it("refuses a claimed gap absence whose scope a rotated child gap still occupies", () => {
    // The retired parent's exact id is gone, but a live child under a rotated
    // route generation holds the same scope; the checker calls it a successor,
    // and an artifact claiming absent must not book.
    const parent = "fixture:gap:route:redemption:11111111-1111-4111-8111-111111111111:output";
    const child = "fixture:gap:route:redemption:22222222-2222-4222-8222-222222222222:output:refined";
    const ledger = makeLedger([
      fixtureDecision({
        taskIds: [PRIMARY_TASK],
        sentinels: [{ doneWhenGapIdAbsent: parent, doneWhenScoreReasonAbsent: null }],
      }),
    ]);
    const registry = makeRegistry([
      { assetId: "fixture", items: [fixtureItem({ taskId: SECONDARY_TASK, gapId: child, reasonCode: "route-cause" })] },
    ]);
    const { artifact } = checkerArtifact({ ledger, registry });
    expect(checkerRow(artifact)).toMatchObject({
      verdict: "replaced-adversely",
      reason: "sibling-sentinel-successor",
    });

    const tampered = {
      ...artifact,
      groups: [
        {
          ...checkerRow(artifact),
          verdict: "closed",
          reason: "sentinels-absent",
          matches: (checkerRow(artifact).matches as { status: string }[]).map((match) => ({
            ...match,
            status: "absent",
          })),
        },
      ],
    };
    const refused = apply(ledger, registry, tampered);
    expect(refused.booked).toEqual([]);
    expect(refused.skipped[0]).toMatchObject({ reason: "sentinel-still-open" });
    expect(refused.skipped[0]!.detail).toContain("occupied");
  });

  it("refuses artifacts with the wrong registry, clock or ledger basis and unbookable rows", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const { artifact } = checkerArtifact({ ledger, registry });

    expectApplyReason(
      () => apply(ledger, registry, artifact, "b".repeat(64)),
      "registry-fingerprint-mismatch",
    );
    expectApplyReason(
      () => parseSentinelResolutions({ ...artifact, groups: [{ ...checkerRow(artifact), asOfSec: CLOCK - 1 }] }),
      "resolutions-schema-invalid",
    );
    const shiftedClock = {
      ...artifact,
      inputs: {
        ...(artifact.inputs as Record<string, unknown>),
        registry: {
          ...((artifact.inputs as Record<string, unknown>).registry as Record<string, unknown>),
          binding: { asOfSec: CLOCK - 1 },
        },
      },
      groups: [{ ...checkerRow(artifact), asOfSec: CLOCK - 1 }],
    };
    expectApplyReason(() => apply(ledger, registry, shiftedClock), "capture-clock-mismatch");
    expectApplyReason(
      () =>
        parseSentinelResolutions({
          ...artifact,
          inputs: {
            ...(artifact.inputs as Record<string, unknown>),
            registry: {
              ...((artifact.inputs as Record<string, unknown>).registry as Record<string, unknown>),
              registrySha256: undefined,
            },
          },
        }),
      "resolutions-schema-invalid",
    );

    // Replaced-adverse and narrative-only verdicts are reported, never booked.
    const adverseRegistry = makeRegistry([
      { assetId: "fixture", items: [fixtureItem({ gapId: "fixture:gap:1", taskId: PRIMARY_TASK, cause: "D" })] },
    ]);
    const adverse = checkerArtifact({ ledger, registry: adverseRegistry });
    expect(checkerRow(adverse.artifact)).toMatchObject({
      verdict: "replaced-adversely",
      reason: "measured-adverse-successor",
    });
    const adverseResult = apply(ledger, adverseRegistry, adverse.artifact);
    expect(adverseResult.booked).toEqual([]);
    expect(adverseResult.skipped[0]!.reason).toBe("verdict-not-bookable");

    const narrative = makeLedger([fixtureDecision({ sentinels: ["watch the next filing"] })]);
    const narrativeArtifact = checkerArtifact({ ledger: narrative, registry });
    expect(checkerRow(narrativeArtifact.artifact)).toMatchObject({
      verdict: "unverifiable",
      reason: "narrative-only-sentinels",
    });
    expect(apply(narrative, registry, narrativeArtifact.artifact).skipped[0]!.reason).toBe("verdict-not-bookable");

    // Quarantine, a missing asset and an admission axis that disagrees with the
    // ledger are all fail-closed skips.
    const quarantined = makeRegistry([{ assetId: "fixture", ratingStatus: "pipeline-gap" }]);
    const quarantinedArtifact = checkerArtifact({ ledger, registry: quarantined });
    expect(apply(ledger, quarantined, quarantinedArtifact.artifact).skipped[0]!.reason).toBe(
      "quarantined-or-missing-asset",
    );

    const foreignLedger = makeLedger([
      fixtureDecision({ claimGroupId: "RESERVE_SLICE:another", reviewedAt: "2026-10-01" }),
    ]);
    const foreignArtifact = checkerArtifact({ ledger: foreignLedger, registry });
    expect(apply(foreignLedger, registry, foreignArtifact.artifact).skipped[0]!.reason).toBe(
      "quarantined-or-missing-asset",
    );

    const mismatchedAdmission = {
      ...artifact,
      groups: [{ ...checkerRow(artifact), admission: "verified" }],
    };
    expect(apply(ledger, registry, mismatchedAdmission).skipped[0]!.reason).toBe("spp-state-mismatch");

    const emptyTasks = makeLedger([fixtureDecision({ taskIds: [] })]);
    const emptyArtifact = checkerArtifact({ ledger: emptyTasks, registry });
    const noClosure = apply(emptyTasks, registry, emptyArtifact.artifact);
    expect(noClosure.booked).toEqual([]);
    expect(noClosure.skipped[0]!.reason).toBe("no-derived-closure");
  });

  it("previews without writing, then appends once even across repeated writes", () => {
    const ledgerPath = temporaryFile("ledger.json");
    const registryPath = temporaryFile("registry.json");
    const resolutionsPath = temporaryFile("resolutions.json");
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    writeFileSync(ledgerPath, serializeCurationLedger(ledger));
    writeFileSync(registryPath, registryBytes(registry));
    const { artifact } = checkerArtifact({ ledger, registry });
    writeFileSync(resolutionsPath, JSON.stringify(artifact));

    const output = { lines: [] as string[], write(text: string) { this.lines.push(text); return true; } };
    const argv = ["--resolutions", resolutionsPath, "--registry", registryPath, "--ledger", ledgerPath];
    const preview = runApplySentinelClosuresCli(argv, { stdout: output });
    expect(preview).toMatchObject({ booked: 1, dryRun: true });
    expect(output.lines.join("")).toContain("pass --write to append");
    expect(parseCurationLedger(JSON.parse(readFileSync(ledgerPath, "utf8"))).decisions).toHaveLength(1);

    const applied = runApplySentinelClosuresCli([...argv, "--write"], { stdout: output });
    expect(applied).toMatchObject({ booked: 1, dryRun: false });
    const afterFirst = readFileSync(ledgerPath, "utf8");
    expect(parseCurationLedger(JSON.parse(afterFirst)).decisions).toHaveLength(2);

    const repeated = runApplySentinelClosuresCli([...argv, "--write"], { stdout: output });
    expect(repeated.booked).toBe(0);
    expect(readFileSync(ledgerPath, "utf8")).toBe(afterFirst);
  });
});
