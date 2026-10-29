import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURATION_LEDGER_DECISION_FIELDS,
  LedgerAppendError,
  appendCurationLedgerDecisions,
  assertCurationLedgerAppendOnly,
  curationLedgerParkState,
  indexLatestCurationDecisions,
  parseCurationLedger,
  runLedgerAppendCli,
  serializeCurationLedger,
  writeCurationLedger,
  type CurationLedger,
  type LedgerAppendFailureReason,
} from "../ledger-append";

const FIXTURE_GROUP = "RESERVE_SLICE:fixture";

function fixtureDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claimGroupId: FIXTURE_GROUP,
    taskIds: ["V9G-aaaaaaaaaaaaaaaa"],
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

function duplicate(decision: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(decision)) as Record<string, unknown>;
}

function expectAppendReason(run: () => unknown, reason: LedgerAppendFailureReason): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerAppendError);
    expect((error as LedgerAppendError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected a LedgerAppendError with reason ${reason}`);
}

const temporaryDirectories: string[] = [];

function temporaryFile(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-ledger-append-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("curation ledger append", () => {
  it("appends a decision after the existing history without changing it", () => {
    const previous = fixtureDecision();
    const ledger = makeLedger([previous]);
    const promote = fixtureDecision({
      decision: "promote",
      reviewedAt: "2026-10-02",
      evidence: ["registry replay 2026-10-02"],
      factsClosed: 2,
    });

    const result = appendCurationLedgerDecisions({ ledger, decisions: [promote] });

    expect(result.appended).toHaveLength(1);
    expect(result.ledger.decisions).toHaveLength(2);
    expect(result.ledger.decisions[0]).toEqual(ledger.decisions[0]);
    const written = result.ledger.decisions[1] as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(
      CURATION_LEDGER_DECISION_FIELDS.filter((field) => field !== "deferState"),
    );
    expect(written).toMatchObject({ claimGroupId: FIXTURE_GROUP, decision: "promote", factsClosed: 2 });
  });

  it("rejects a decision already present in the ledger and duplicates inside one batch", () => {
    const existing = fixtureDecision();
    const ledger = makeLedger([existing]);

    expectAppendReason(
      () => appendCurationLedgerDecisions({ ledger, decisions: [duplicate(existing)] }),
      "duplicate-decision",
    );

    const newDecision = fixtureDecision({ reviewedAt: "2026-10-03", evidence: ["new source"] });
    expectAppendReason(
      () => appendCurationLedgerDecisions({ ledger, decisions: [newDecision, duplicate(newDecision)] }),
      "duplicate-decision",
    );
  });

  it("rejects schema drift, unknown vocabulary and blank provenance", () => {
    const ledger = makeLedger([fixtureDecision()]);
    const invalid: [Record<string, unknown>, LedgerAppendFailureReason][] = [
      [{ ...fixtureDecision(), extraField: true }, "decision-schema-invalid"],
      [{ ...fixtureDecision(), rationale: "" }, "decision-schema-invalid"],
      [{ ...fixtureDecision(), evidence: [] }, "decision-schema-invalid"],
      [{ ...fixtureDecision(), factsClosed: -1 }, "decision-schema-invalid"],
      [{ ...fixtureDecision(), reviewedAt: "not-a-date" }, "decision-schema-invalid"],
      [{ ...fixtureDecision(), workType: "WRAPPER_EXIT_FACTS" }, "unknown-work-type"],
      [{ ...fixtureDecision(), resolutionMode: "legacy-mode" }, "unknown-resolution-mode"],
      [{ ...fixtureDecision(), claimGroupId: "MINT_AUTHORITY:fixture" }, "claim-group-work-type-mismatch"],
    ];
    for (const [candidate, reason] of invalid) {
      expectAppendReason(() => appendCurationLedgerDecisions({ ledger, decisions: [candidate] }), reason);
    }
    const drifted = {
      schemaVersion: 1,
      description: "Fixture curation ledger",
      decisionFields: CURATION_LEDGER_DECISION_FIELDS.filter((field) => field !== "factsClosed"),
      allowedDecisions: ["promote", "reject", "defer"],
      decisions: [],
    };
    expectAppendReason(() => parseCurationLedger(drifted), "ledger-envelope-invalid");
  });

  it("requires a sentinel on new defers but not on promote or reject", () => {
    const ledger = makeLedger([]);
    expectAppendReason(
      () => appendCurationLedgerDecisions({ ledger, decisions: [fixtureDecision({ sentinels: [] })] }),
      "defer-requires-sentinel",
    );

    const promoted = appendCurationLedgerDecisions({
      ledger,
      decisions: [fixtureDecision({ decision: "promote", sentinels: [], factsClosed: 1 })],
    });
    expect(promoted.ledger.decisions).toHaveLength(1);

    const prose = appendCurationLedgerDecisions({
      ledger,
      decisions: [fixtureDecision({ reviewedAt: "2026-10-02", sentinels: ["watch the next filing"] })],
    });
    expect(prose.ledger.decisions).toHaveLength(1);
  });

  it("parks a fourth identical outcome unless unpark evidence or a fired trigger is recorded", () => {
    const history = [1, 2, 3].map((day) =>
      fixtureDecision({ reviewedAt: `2026-10-0${day}`, evidence: [`source ${day}`] }),
    );
    const ledger = makeLedger(history);
    const fourth = fixtureDecision({ reviewedAt: "2026-10-04", evidence: ["source 4"] });

    expectAppendReason(
      () => appendCurationLedgerDecisions({ ledger, decisions: [fourth] }),
      "parked-repeated-outcome",
    );

    const fired = appendCurationLedgerDecisions({
      ledger,
      decisions: [fourth],
      triggerFiredGroups: [FIXTURE_GROUP],
    });
    expect(fired.appended).toHaveLength(1);

    const unparked = appendCurationLedgerDecisions({
      ledger,
      decisions: [
        fixtureDecision({
          reviewedAt: "2026-10-04",
          evidence: ["source 4"],
          unpark: { rationale: "New issuer disclosure", evidence: ["issuer filing 2026-10-03"] },
        }),
      ],
    });
    expect(unparked.appended).toHaveLength(1);

    const changedOutcome = appendCurationLedgerDecisions({
      ledger,
      decisions: [fixtureDecision({ reviewedAt: "2026-10-04", evidence: ["source 4"], decision: "promote", factsClosed: 1 })],
    });
    expect(changedOutcome.appended).toHaveLength(1);
  });

  it("refuses unpark evidence that the group already cited", () => {
    const history = [1, 2, 3].map((day) =>
      fixtureDecision({ reviewedAt: `2026-10-0${day}`, evidence: [`source ${day}`] }),
    );
    const ledger = makeLedger(history);
    expectAppendReason(
      () =>
        appendCurationLedgerDecisions({
          ledger,
          decisions: [
            fixtureDecision({
              reviewedAt: "2026-10-04",
              evidence: ["source 4"],
              unpark: { rationale: "Repeat", evidence: ["source 1"] },
            }),
          ],
        }),
      "unpark-evidence-not-new",
    );
  });

  it("refuses to modify, reorder or shrink history", () => {
    const first = fixtureDecision();
    const second = fixtureDecision({ reviewedAt: "2026-10-02", evidence: ["source 2"] });
    const previous = makeLedger([first, second]);

    expectAppendReason(
      () => assertCurationLedgerAppendOnly(previous, makeLedger([first])),
      "append-only-violation",
    );
    expectAppendReason(
      () => assertCurationLedgerAppendOnly(previous, makeLedger([second, first])),
      "append-only-violation",
    );
    expectAppendReason(
      () => assertCurationLedgerAppendOnly(previous, makeLedger([first, { ...second, rationale: "edited" }])),
      "append-only-violation",
    );
    expect(
      assertCurationLedgerAppendOnly(previous, makeLedger([first, second, fixtureDecision({ reviewedAt: "2026-10-03" })])),
    ).toBeUndefined();
  });

  it("preserves historical key order and unknown fields across a read/write cycle", () => {
    const raw = {
      schemaVersion: 1,
      description: "Fixture curation ledger",
      decisionFields: [...CURATION_LEDGER_DECISION_FIELDS],
      allowedDecisions: ["promote", "reject", "defer"],
      decisions: [
        {
          decision: "defer",
          deferState: "structured-pending-production",
          evidence: ["source"],
          rationale: "Historical row order.",
          nextReviewTrigger: "Later.",
          claimGroupId: FIXTURE_GROUP,
          taskIds: ["V9G-aaaaaaaaaaaaaaaa"],
          workType: "RESERVE_SLICE",
          resolutionMode: "agent-curation",
          reviewedAt: "2026-10-01",
          reviewer: "fixture/reviewer",
          changeRefs: [],
          sentinels: ["prose sentinel"],
          factsClosed: 0,
          family: "legacy-family",
        },
      ],
    };
    const text = `${JSON.stringify(raw, null, 2)}\n`;
    expect(serializeCurationLedger(parseCurationLedger(JSON.parse(text)))).toBe(text);
  });

  it("writes atomically, refuses concurrent or rewriting writes, and is idempotent", () => {
    const path = temporaryFile("ledger.json");
    const ledger = makeLedger([fixtureDecision()]);
    writeCurationLedger({ path, ledger });
    const bytes = readFileSync(path, "utf8");
    writeCurationLedger({ path, ledger });
    expect(readFileSync(path, "utf8")).toBe(bytes);

    const appended = appendCurationLedgerDecisions({
      ledger,
      decisions: [fixtureDecision({ reviewedAt: "2026-10-02", evidence: ["source 2"] })],
    }).ledger;
    writeCurationLedger({ path, ledger: appended, expectedSha256: undefined });
    expect(parseCurationLedger(JSON.parse(readFileSync(path, "utf8"))).decisions).toHaveLength(2);

    expectAppendReason(
      () => writeCurationLedger({ path, ledger: makeLedger([fixtureDecision()]), expectedSha256: "0".repeat(64) }),
      "ledger-changed",
    );
    expectAppendReason(
      () => writeCurationLedger({ path, ledger }),
      "append-only-violation",
    );
  });

  it("reports parked state for the worklist without file I/O", () => {
    const history = [1, 2, 3].map((day) =>
      fixtureDecision({ reviewedAt: `2026-10-0${day}`, evidence: [`source ${day}`] }),
    );
    const parked = makeLedger(history);
    expect(curationLedgerParkState(parked.decisions).get(FIXTURE_GROUP)).toBe("parked");

    const unparked = makeLedger([
      ...history.slice(0, 2),
      fixtureDecision({
        reviewedAt: "2026-10-03",
        evidence: ["source 3"],
        unpark: { rationale: "Fresh evidence", evidence: ["filing 2026-10-03"] },
      }),
    ]);
    expect(curationLedgerParkState(unparked.decisions).get(FIXTURE_GROUP)).toBe("active");
  });

  it("previews without writing and appends only with an explicit --write", () => {
    const ledgerPath = temporaryFile("ledger.json");
    const decisionsPath = temporaryFile("decisions.json");
    writeFileSync(ledgerPath, serializeCurationLedger(makeLedger([fixtureDecision()])));
    writeFileSync(decisionsPath, JSON.stringify([
      fixtureDecision({ reviewedAt: "2026-10-02", evidence: ["source 2"] }),
    ]));

    const output = { lines: [] as string[], write(text: string) { this.lines.push(text); return true; } };
    expect(runLedgerAppendCli(["--decisions", decisionsPath, "--ledger", ledgerPath], { stdout: output })).toBe(1);
    expect(parseCurationLedger(JSON.parse(readFileSync(ledgerPath, "utf8"))).decisions).toHaveLength(1);
    expect(output.lines.join("")).toContain("pass --write to append");

    expect(runLedgerAppendCli(["--decisions", decisionsPath, "--ledger", ledgerPath, "--dry-run"], { stdout: output })).toBe(1);
    expect(parseCurationLedger(JSON.parse(readFileSync(ledgerPath, "utf8"))).decisions).toHaveLength(1);

    expect(() =>
      runLedgerAppendCli(["--decisions", decisionsPath, "--ledger", ledgerPath, "--write", "--dry-run"], { stdout: output }),
    ).toThrow(/cannot be used together/);
    expect(parseCurationLedger(JSON.parse(readFileSync(ledgerPath, "utf8"))).decisions).toHaveLength(1);

    expect(runLedgerAppendCli(["--decisions", decisionsPath, "--ledger", ledgerPath, "--write"], { stdout: output })).toBe(1);
    expect(parseCurationLedger(JSON.parse(readFileSync(ledgerPath, "utf8"))).decisions).toHaveLength(2);

    writeFileSync(decisionsPath, readFileSync(ledgerPath, "utf8"));
    expectAppendReason(
      () => runLedgerAppendCli(["--decisions", decisionsPath, "--ledger", ledgerPath, "--write"], { stdout: output }),
      "decision-input-invalid",
    );
  });

  it("selects each group's latest decision by reviewedAt, ties to the later append", () => {
    const otherGroup = "MINT_AUTHORITY:fixture";
    const ledger = makeLedger([
      fixtureDecision({ reviewedAt: "2026-10-05", evidence: ["newest"] }),
      fixtureDecision({ reviewedAt: "2026-10-01", evidence: ["backdated"] }),
      fixtureDecision({
        claimGroupId: otherGroup,
        workType: "MINT_AUTHORITY",
        reviewedAt: "2026-10-03",
        evidence: ["tie a"],
      }),
      fixtureDecision({
        claimGroupId: otherGroup,
        workType: "MINT_AUTHORITY",
        reviewedAt: "2026-10-03",
        evidence: ["tie b"],
      }),
    ]);

    const latest = indexLatestCurationDecisions(ledger.decisions);
    expect(latest.get(FIXTURE_GROUP)).toMatchObject({ index: 0 });
    expect(latest.get(otherGroup)).toMatchObject({ index: 3 });
  });
});
