import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("keeps the #945 syrupusdt X Layer defer free of closed task ids, dead citations and unconfirmed owners", () => {
    const artifact = resolve(
      import.meta.dirname,
      "../../../.github/artifacts/safety-score-missing-data-reviewed-ledger.json",
    );
    const decisions = parseCurationLedger(JSON.parse(readFileSync(artifact, "utf8"))).decisions;
    // Select the 2026-11-20 defer itself, not the group's latest decision: a valid
    // later promotion must leave this historical entry's assertions untouched.
    const defer = decisions.find(
      (decision) =>
        decision.claimGroupId === "DEPLOYMENT_CONTROLS:syrupusdt-maple" &&
        decision.reviewedAt === "2026-11-20" &&
        decision.decision === "defer",
    );
    expect(defer).toMatchObject({ taskIds: [] });
    expect(defer?.nextReviewTrigger).toContain("Manual completion");
    expect(defer?.nextReviewTrigger).toContain("2026-11-26T16:54:13Z");
    // The ledger designates the owner but never self-certifies it ("confirmed
    // 2026-11-20" passed with all four live #945 comments acknowledging no owner):
    // the acknowledgment is the lead's comment, which every existing comment
    // (latest 2026-10-28, re-checked 2026-11-20) still lacks.
    expect(defer?.nextReviewTrigger).toContain(
      "Owner: the 2026-11-24 weekly curation-expiry sweep operator lane",
    );
    expect(defer?.nextReviewTrigger).toContain("designated 2026-11-20");
    expect(defer?.nextReviewTrigger).not.toContain("confirmed 2026-11-20");
    expect(defer?.nextReviewTrigger).not.toContain("assignment pending");
    expect(defer?.nextReviewTrigger).toContain("acknowledges this owner");
    expect(defer?.nextReviewTrigger).toContain("none of the four existing comments");
    // The posted #945 comment carries the assignment and the dated sDOLA/srUSD
    // waits; the trigger stays their durable carrier until the comment lands.
    expect(defer?.nextReviewTrigger).toContain("dated sDOLA and srUSD issuer waits");
    // Each of the three checks ends its own clause with a dated recheck: the
    // lapse operator must not depend on one entry-level trailing date.
    expect(defer?.nextReviewTrigger).toMatch(
      /emitted sentinel \(recheck 2026-11-26T16:54:13Z lapse, then each weekly sweep until closed\)/,
    );
    expect(defer?.nextReviewTrigger).toMatch(
      /not an event of TokenPool\); recheck 2026-11-26T16:54:13Z lapse, then each weekly sweep until closed/,
    );
    expect(defer?.nextReviewTrigger).toMatch(
      /0x3b59f232 filter was void\); recheck 2026-11-26T16:54:13Z lapse, then each weekly sweep until closed/,
    );
    // The waits' checks ride this entry too (the sDOLA group is churn-parked and
    // scratch is not durable): the lapse operator must find them here until posted.
    expect(defer?.nextReviewTrigger).toContain("ChainAdded/ChainRemoved/RemotePoolAdded/RemotePoolRemoved");
    expect(defer?.nextReviewTrigger).toContain("mill 396");
    expect(defer?.nextReviewTrigger).toContain("0xee94a30e topic filter was void");
    // Full topic hash: a corrupted suffix passes a prefix assertion while the
    // filtered scan silently comes back empty and misses real history.
    expect(defer?.nextReviewTrigger).toContain(
      "PeerSet(uint32,bytes32) topic0 0x238399d427b947898edb290f5ff0f9109849b1c3ba196a42e35f00c50a54b98b",
    );
    expect(defer?.nextReviewTrigger).toContain("0x316cd39632cac4f4cdfc21757c4500fe12f64514");
    expect(defer?.nextReviewTrigger).toContain("0x5475611dffb8ef4d697ae39df9395513b6e947d7");
    // Each scan's own clause starts at the 2026-10-27 prior-review clock: a global
    // occurrence count passes when the sDOLA clause carries both dates and the
    // srUSD scan starts after the review window.
    expect(defer?.nextReviewTrigger).toMatch(
      /ChainAdded\/ChainRemoved\/RemotePoolAdded\/RemotePoolRemoved since 2026-10-27T16:54:13Z/,
    );
    expect(defer?.nextReviewTrigger).toMatch(
      /0x5475611dffb8ef4d697ae39df9395513b6e947d7 since 2026-10-27T16:54:13Z/,
    );
    // sDOLA reconciles pinned token/pool identity before scanning, and the scan
    // covers every reconciled pair: listing both Arbitrum pools as evidence is not
    // scanning them — a census-pools-only trigger skips the directory pool's events.
    expect(defer?.nextReviewTrigger).toContain("pinned token/pool identity reconciliation");
    expect(defer?.nextReviewTrigger).toContain(
      "on every further pair the reconciliation surfaces, never census pools alone",
    );
    expect(defer?.nextReviewTrigger).toContain("scan both pools where they disagree");
    expect(defer?.nextReviewTrigger).toContain("0xe24c58d2e4dfd043766c0fcb6895f0dc46e114ff");
    expect(defer?.nextReviewTrigger).toContain("0xbbc28db61df26b76d5f7d5eed17ed4d6c278460e");
    // The directory delta stays observation-only: a cached five-network response
    // then a fresh three-network one looks identical to real churn, so the trigger
    // keeps the dated three-network read without asserting an intraday change.
    expect(defer?.nextReviewTrigger).toContain("read 2026-11-20, three networks");
    expect(defer?.nextReviewTrigger).toContain("an earlier same-day read showed five");
    expect(defer?.nextReviewTrigger).toContain("cached-then-fresh response sequence looks the same");
    expect(defer?.nextReviewTrigger).not.toContain("intraday");
    const evidence = (defer?.evidence ?? []).map(String);
    expect(evidence.some((line) => line.includes("syrupusd-crosschain.md"))).toBe(true);
    expect(evidence.some((line) => line.includes("syrupusdt-crosschain.md"))).toBe(false);
    expect(evidence.some((line) => line.includes("six networks including X Layer"))).toBe(true);
    expect(evidence.some((line) => line.includes("still lists five networks without X Layer"))).toBe(false);
    expect(evidence.some((line) => line.includes("churns intraday"))).toBe(false);
    // Same pinned-evidence provenance for the X Layer reads: a reviewer replaying
    // the deployment-timing eth_getCode reads must hit the exact blocks that dated
    // the deployment, so both pins carry the keyless URL and full block hashes.
    const xlayerState = evidence.find((line) => line.includes("76367070"));
    expect(xlayerState).toContain("https://rpc.xlayer.tech");
    expect(xlayerState).toContain("0x7eca75d94d48354e1bb0be914385d8ee630cc873e8e1ddfd2fb780580fbbccb3");
    expect(xlayerState).toContain("eth_call typeAndVersion()/getSupportedChains()/getToken()");
    // The observation window opens at the first successful call (03:53:53Z): the
    // 03:53:45Z batch reverted with no results. The state block's own timestamp
    // is pinned, and totalSupply() is bound to the token — the pool call reverts.
    expect(xlayerState).toContain("observedAt 2026-11-20T03:53:53Z–03:54:06Z");
    expect(xlayerState).toContain("block timestamp 2026-11-20T00:55:06Z");
    expect(xlayerState).toContain(
      "eth_call totalSupply() on token 0xd7f1eb70a6a471548a2fab5e0af5eb8cb289d547",
    );
    const xlayerTiming = evidence.find((line) => line.includes("Deployment timing"));
    expect(xlayerTiming).toContain("https://rpc.xlayer.tech");
    expect(xlayerTiming).toContain("eth_getCode");
    expect(xlayerTiming).toContain("0x0a04a99b49b820e63280f4430a34cce7f74667c8b7dfd1b63d02b9cb136f7f09");
    expect(xlayerTiming).toContain("0xce30442b40b9881e3842d2a252af1028ecfc066185abcf34faf371594db33332");
    // Each pin binds its block to its own block timestamp and observation time:
    // a shared "observedAt 03:53" prefix passes when the second time disappears
    // or the state timestamp drifts to an observation time.
    expect(xlayerTiming).toMatch(
      /block 74351017[^;]*timestamp 2026-10-27T16:54:13Z[^;]*observedAt 2026-11-20T03:53:23Z/,
    );
    expect(xlayerTiming).toMatch(
      /block 74525375[^;]*timestamp 2026-10-29T17:20:11Z[^;]*observedAt 2026-11-20T03:53:25Z/,
    );
    // Pinned-evidence provenance (docs/process/agent-artifacts.md): the Arbitrum
    // reads cite the keyless endpoint, the pinned block hash and the exact methods,
    // so the next reviewer can reproduce the same pinned state.
    const arbReads = evidence.find((line) => line.includes("Arbitrum pinned reads"));
    expect(arbReads).toContain("https://api-arbitrum-mainnet-archive.n.dwellir.com");
    expect(arbReads).toContain("0x01bb113328dbf74ee9c81621f859b8d722f15669c9f08456cf195b98ea98d097");
    expect(arbReads).toContain("eth_call symbol()/totalSupply() + eth_getCode");
  });
});
