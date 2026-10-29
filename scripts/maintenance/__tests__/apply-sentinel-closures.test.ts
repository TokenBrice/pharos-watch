import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
const FINGERPRINT = "a".repeat(64);
const FIXTURE_GROUP = "RESERVE_SLICE:fixture";
const PRIMARY_TASK = "V9G-aaaaaaaaaaaaaaaa";
const SECONDARY_TASK = "V9G-bbbbbbbbbbbbbbbb";
const REVIEWED_AT = new Date(CLOCK * 1000).toISOString().slice(0, 10);

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
    gapId: "fixture:gap:2",
    reasonCode: "material-reserve-slice-unstructured",
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
      policyId: "fixture-policy",
      policyDigest: "policy-digest",
      queueDigest: "queue-digest",
      candidateId: "candidate",
      resultDigest: "result-digest",
    },
    stablecoins: assets.map(({ assetId, ratingStatus = "rated", items = [] }) => ({
      assetId,
      currentScore: { ratingStatus },
      missingItems: items,
    })),
  };
}

function makeArtifact(
  ledger: CurationLedger,
  rows: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAtSec: CLOCK + 60,
    registryFingerprint: FINGERPRINT,
    captureClockSec: CLOCK,
    ledgerDecisionCount: ledger.decisions.length,
    rows,
    ...overrides,
  };
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
  it("books a clean bookable verdict as a promote with derived factsClosed", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const artifact = makeArtifact(ledger, [
      { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0, items: 0 },
    ]);

    const result = applySentinelClosures({
      ledger,
      registry,
      resolutions: artifact,
      registryFingerprint: FINGERPRINT,
    });

    expect(result.skipped).toEqual([]);
    expect(result.booked).toHaveLength(1);
    const record = result.booked[0]!.decisionRecord;
    expect(record).toMatchObject({
      claimGroupId: FIXTURE_GROUP,
      decision: "promote",
      taskIds: [],
      sentinels: [],
      factsClosed: 2,
      reviewer: `sentinel-sweep/${CLOCK + 60}`,
      reviewedAt: REVIEWED_AT,
    });
    expect(record.evidence[0]).toContain(`registry ${FINGERPRINT} @ ${CLOCK}:`);
    expect(record.evidence[0]).toContain("factsClosed 2 re-derived");
    expect(result.ledger.decisions).toHaveLength(2);
    expect(result.ledger.decisions[0]).toEqual(ledger.decisions[0]);
  });

  it("is idempotent across repeat runs of the same artifact", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const registry = makeRegistry([{ assetId: "fixture" }]);
    const artifact = makeArtifact(ledger, [
      { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0 },
    ]);
    const first = applySentinelClosures({
      ledger,
      registry,
      resolutions: artifact,
      registryFingerprint: FINGERPRINT,
    });
    expect(first.booked).toHaveLength(1);

    const second = applySentinelClosures({
      ledger: first.ledger,
      registry,
      resolutions: artifact,
      registryFingerprint: FINGERPRINT,
    });
    expect(second.booked).toEqual([]);
    expect(second.skipped.map((entry) => entry.reason)).toEqual(["already-applied"]);
    expect(second.ledger.decisions).toHaveLength(first.ledger.decisions.length);
  });

  it("never books a group whose sentinel is still open or not machine-checkable", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const openRegistry = makeRegistry([
      { assetId: "fixture", items: [fixtureItem({ gapId: "fixture:gap:1" })] },
    ]);
    const openArtifact = makeArtifact(ledger, [
      { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0, items: 1 },
    ]);
    const open = applySentinelClosures({
      ledger,
      registry: openRegistry,
      resolutions: openArtifact,
      registryFingerprint: FINGERPRINT,
    });
    expect(open.booked).toEqual([]);
    expect(open.skipped[0]!.reason).toBe("sentinel-still-open");

    const proseLedger = makeLedger([fixtureDecision({ sentinels: ["watch the next filing"] })]);
    const prose = applySentinelClosures({
      ledger: proseLedger,
      registry: makeRegistry([{ assetId: "fixture" }]),
      resolutions: makeArtifact(proseLedger, [
        { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0 },
      ]),
      registryFingerprint: FINGERPRINT,
    });
    expect(prose.booked).toEqual([]);
    expect(prose.skipped[0]!.reason).toBe("non-machine-sentinel");
  });

  it("books a split as a partial promote that carries the outstanding sentinels", () => {
    const ledger = makeLedger([
      fixtureDecision({
        sentinels: [
          { doneWhenGapIdAbsent: "fixture:gap:1", doneWhenScoreReasonAbsent: null },
          { doneWhenGapIdAbsent: "fixture:gap:2" },
        ],
      }),
    ]);
    const registry = makeRegistry([{ assetId: "fixture", items: [fixtureItem()] }]);
    const artifact = makeArtifact(ledger, [
      { claimGroupId: FIXTURE_GROUP, verdict: "split", ledgerDecisionIndex: 0, items: 1 },
    ]);

    const result = applySentinelClosures({
      ledger,
      registry,
      resolutions: artifact,
      registryFingerprint: FINGERPRINT,
    });

    expect(result.booked).toHaveLength(1);
    const record = result.booked[0]!.decisionRecord;
    expect(record).toMatchObject({
      decision: "promote",
      taskIds: [SECONDARY_TASK],
      factsClosed: 1,
      sentinels: [{ doneWhenGapIdAbsent: "fixture:gap:2", doneWhenScoreReasonAbsent: null }],
    });
  });

  it("books admission-failed as a reject without claiming facts", () => {
    const ledger = makeLedger([
      fixtureDecision({
        deferState: "structured-pending-production",
        sentinels: [{ doneWhenGapIdAbsent: "fixture:gap:1", doneWhenScoreReasonAbsent: null }],
      }),
    ]);
    const registry = makeRegistry([
      { assetId: "fixture", items: [fixtureItem({ gapId: "fixture:gap:1" })] },
    ]);
    const artifact = makeArtifact(ledger, [
      { claimGroupId: FIXTURE_GROUP, verdict: "admission-failed", ledgerDecisionIndex: 0, items: 1 },
    ]);

    const result = applySentinelClosures({
      ledger,
      registry,
      resolutions: artifact,
      registryFingerprint: FINGERPRINT,
    });

    expect(result.booked).toHaveLength(1);
    const record = result.booked[0]!.decisionRecord;
    expect(record).toMatchObject({
      decision: "reject",
      factsClosed: 0,
      taskIds: [PRIMARY_TASK, SECONDARY_TASK],
      sentinels: [{ doneWhenGapIdAbsent: "fixture:gap:1", doneWhenScoreReasonAbsent: null }],
    });
    expect(record.evidence[0]).toContain("admission failed");
  });

  it("refuses stale ledger bases, wrong registries, quarantine and unbookable verdicts", () => {
    const history = makeLedger([
      fixtureDecision(),
      fixtureDecision({ reviewedAt: "2026-10-02", evidence: ["source 2"] }),
    ]);
    const stale = applySentinelClosures({
      ledger: history,
      registry: makeRegistry([{ assetId: "fixture" }]),
      resolutions: makeArtifact(history, [
        { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0 },
      ]),
      registryFingerprint: FINGERPRINT,
    });
    expect(stale.skipped[0]!.reason).toBe("ledger-advanced");

    const single = makeLedger([fixtureDecision()]);
    expectApplyReason(
      () =>
        applySentinelClosures({
          ledger: single,
          registry: makeRegistry([{ assetId: "fixture" }]),
          resolutions: makeArtifact(single, [
            { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0 },
          ], { registryFingerprint: "b".repeat(64) }),
          registryFingerprint: FINGERPRINT,
        }),
      "registry-fingerprint-mismatch",
    );
    expectApplyReason(
      () =>
        applySentinelClosures({
          ledger: single,
          registry: makeRegistry([{ assetId: "fixture" }]),
          resolutions: makeArtifact(single, [
            { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0 },
          ], { captureClockSec: CLOCK - 1 }),
          registryFingerprint: FINGERPRINT,
        }),
      "capture-clock-mismatch",
    );

    const quarantined = applySentinelClosures({
      ledger: single,
      registry: makeRegistry([{ assetId: "fixture", ratingStatus: "pipeline-gap" }]),
      resolutions: makeArtifact(single, [
        { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0 },
      ]),
      registryFingerprint: FINGERPRINT,
    });
    expect(quarantined.booked).toEqual([]);
    expect(quarantined.skipped[0]!.reason).toBe("quarantined-or-missing-asset");

    const missingAsset = applySentinelClosures({
      ledger: single,
      registry: makeRegistry([{ assetId: "another-fixture" }]),
      resolutions: makeArtifact(single, [
        { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0 },
      ]),
      registryFingerprint: FINGERPRINT,
    });
    expect(missingAsset.skipped[0]!.reason).toBe("quarantined-or-missing-asset");

    const pending = applySentinelClosures({
      ledger: single,
      registry: makeRegistry([{ assetId: "fixture" }]),
      resolutions: makeArtifact(single, [
        { claimGroupId: FIXTURE_GROUP, verdict: "pending", ledgerDecisionIndex: 0 },
      ]),
      registryFingerprint: FINGERPRINT,
    });
    expect(pending.skipped[0]!.reason).toBe("verdict-not-bookable");

    const sppMismatch = applySentinelClosures({
      ledger: single,
      registry: makeRegistry([{ assetId: "fixture" }]),
      resolutions: makeArtifact(single, [
        { claimGroupId: FIXTURE_GROUP, verdict: "admission-verified", ledgerDecisionIndex: 0 },
      ]),
      registryFingerprint: FINGERPRINT,
    });
    expect(sppMismatch.skipped[0]!.reason).toBe("spp-state-mismatch");

    const emptyTasks = makeLedger([fixtureDecision({ taskIds: [] })]);
    const noClosure = applySentinelClosures({
      ledger: emptyTasks,
      registry: makeRegistry([{ assetId: "fixture" }]),
      resolutions: makeArtifact(emptyTasks, [
        { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0 },
      ]),
      registryFingerprint: FINGERPRINT,
    });
    expect(noClosure.skipped[0]!.reason).toBe("no-derived-closure");
  });

  it("accepts per-row provenance but rejects a mixed registry basis", () => {
    const resolutions = {
      schemaVersion: 1,
      generatedAtSec: CLOCK + 60,
      rows: [
        {
          claimGroupId: FIXTURE_GROUP,
          verdict: "bookable",
          registryFingerprint: FINGERPRINT,
          captureClockSec: CLOCK,
        },
      ],
    };
    expect(parseSentinelResolutions(resolutions)).toMatchObject({
      registryFingerprint: FINGERPRINT,
      captureClockSec: CLOCK,
    });
    expectApplyReason(
      () =>
        parseSentinelResolutions({
          ...resolutions,
          rows: [
            ...resolutions.rows,
            {
              claimGroupId: "MINT_AUTHORITY:second",
              verdict: "bookable",
              registryFingerprint: "b".repeat(64),
              captureClockSec: CLOCK,
            },
          ],
        }),
      "resolutions-schema-invalid",
    );
  });

  it("previews without writing, then appends once even across repeated writes", () => {
    const ledgerPath = temporaryFile("ledger.json");
    const registryPath = temporaryFile("registry.json");
    const resolutionsPath = temporaryFile("resolutions.json");
    const ledger = makeLedger([fixtureDecision()]);
    const registryBytes = `${JSON.stringify(makeRegistry([{ assetId: "fixture" }]), null, 2)}\n`;
    writeFileSync(ledgerPath, serializeCurationLedger(ledger));
    writeFileSync(registryPath, registryBytes);
    const artifact = makeArtifact(ledger, [
      { claimGroupId: FIXTURE_GROUP, verdict: "bookable", ledgerDecisionIndex: 0 },
    ], { registryFingerprint: sha256Hex(registryBytes) });
    writeFileSync(resolutionsPath, JSON.stringify(artifact));

    const output = { lines: [] as string[], write(text: string) { this.lines.push(text); return true; } };
    const argv = ["--resolutions", resolutionsPath, "--registry", registryPath, "--ledger", ledgerPath];
    const preview = runApplySentinelClosuresCli(argv, { stdout: output });
    expect(preview).toMatchObject({ booked: 1, dryRun: true });
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
