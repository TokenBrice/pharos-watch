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

const CLOCK = 1_793_294_244;
const FIXTURE_GROUP = "RESERVE_SLICE:fixture";
const PRIMARY_TASK = "V9G-aaaaaaaaaaaaaaaa";
const SECONDARY_TASK = "V9G-bbbbbbbbbbbbbbbb";
const REVIEWED_AT = new Date(CLOCK * 1000).toISOString().slice(0, 10);
const REGISTRY_PATH = "fixture/missing-data-registry.json";
const LEDGER_PATH = "fixture/ledger.json";

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
    sentinels: [{ doneWhenGapIdAbsent: "fixture:gap:1", doneWhenScoreReasonAbsent: null }],
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
  assets: { assetId: string; ratingStatus?: string | null; items?: unknown[] }[],
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    snapshot: {
      asOfSec: CLOCK,
      candidateId: "safety-score-v9:v1:fixture",
      publicationGenerationId: "generation:fixture",
    },
    workTypeDefinitions: { RESERVE_SLICE: { description: "Fixture work type" } },
    stablecoins: assets.map(({ assetId, ratingStatus = "rated", items = [] }) => ({
      assetId,
      currentScore: { ratingStatus },
      missingItems: items,
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

  it("refuses registry-snapshot artifacts that no replay verified", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const { artifact } = checkerArtifact({ ledger, registry, replay: false });
    expect((artifact.inputs as Record<string, unknown>).closureEvidence).toBe("registry-snapshot");

    expectApplyReason(() => parseSentinelResolutions(artifact), "closure-evidence-insufficient");
    expectApplyReason(() => apply(ledger, registry, artifact), "closure-evidence-insufficient");
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
