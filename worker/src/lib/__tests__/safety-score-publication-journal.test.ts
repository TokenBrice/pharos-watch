import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { buildSafetyScoreCompactCard, journalSafetyScorePublication, safetyScoreCompactDigest, safetyScoreJournalCardChanged } from "../safety-score-v9/publication-journal";

const identity = { methodologyVersion: "10.12", policyDigest: "a".repeat(64), evaluationBuildDigest: "b".repeat(64) };

describe("compact Safety publication journal", () => {
  it("preserves unavailable scores, pipeline causes, inclusion, peg and binding caps", () => {
    const card = makeWorkerV9Card();
    const compact = buildSafetyScoreCompactCard({ ...card, score: null, grade: null, ratingStatus: "pipeline-gap",
      reasonCodes: ["single-pillar-pipeline-gap"],
      breakdowns: null,
      pillars: { ...card.pillars, exit: { ...card.pillars.exit, score: null, aggregationDisposition: "excluded-a-b" } },
      bindingCap: { kind: "test-cap", reason: "parent unavailable", limit: 35, source: "parent", binding: true },
    });
    expect(compact).toMatchObject({ score: null, grade: null, ratingStatus: "pipeline-gap", reasonCodes: ["single-pillar-pipeline-gap"],
      pillars: { exit: { score: null, inclusion: "excluded-a-b" } }, pegMultiplier: card.pegMultiplier,
      bindingCap: { kind: "test-cap", reason: "parent unavailable", limit: 35 }, primaryExitRoute: null });
  });

  it("retains selected route capacity and evidence but excludes generation keys and observation clocks from movement", () => {
    const card = makeWorkerV9Card();
    const primary = card.breakdowns!.exit.primaryRoute!;
    const withCapacity = { ...card, breakdowns: { ...card.breakdowns!, exit: { ...card.breakdowns!.exit,
      primaryRoute: { ...primary, capacity: { executableUsd: 1_000_000, requestedNotionalUsd: 1_000_000,
        completionRatio: 1, maxCostBps: 200, executionCostBps: 5, settlementDelaySec: 0,
        capacityScoringHorizon: "immediate" as const, chain: "ethereum", protocol: "circle", poolId: null,
        evidenceKind: "measured-executable-depth", observedAtSec: 90 } } } } };
    const compact = buildSafetyScoreCompactCard(withCapacity);
    expect(compact.primaryExitRoute).toMatchObject({
      routeId: "reviewed", lane: "redemption", executableUsd: 1_000_000,
      evidenceKind: "measured-executable-depth", capacityEvidenceTier: "live-direct", confidenceFactor: 1,
    });
    const digest = safetyScoreCompactDigest(compact, identity);
    // Generation re-keys and quote observation clocks are lineage, not movement.
    expect(safetyScoreCompactDigest(buildSafetyScoreCompactCard({
      ...withCapacity, breakdowns: { ...withCapacity.breakdowns!, exit: { ...withCapacity.breakdowns!.exit,
        primaryRoute: { ...withCapacity.breakdowns!.exit.primaryRoute!, key: "redemption:new-generation:reviewed",
          capacity: { ...withCapacity.breakdowns!.exit.primaryRoute!.capacity!, observedAtSec: 95 } } } },
    }), identity)).toBe(digest);
    // Capacity and evidence-kind changes are genuine movement inputs.
    for (const capacityUpdate of [
      { executableUsd: 500_000 },
      { evidenceKind: "documented-terms" },
    ] as const) {
      expect(safetyScoreCompactDigest(buildSafetyScoreCompactCard({
        ...withCapacity, breakdowns: { ...withCapacity.breakdowns!, exit: { ...withCapacity.breakdowns!.exit,
          primaryRoute: { ...withCapacity.breakdowns!.exit.primaryRoute!, capacity: { ...withCapacity.breakdowns!.exit.primaryRoute!.capacity!,
            ...capacityUpdate } } } },
      }), identity)).not.toBe(digest);
    }
  });

  it("has a stable semantic digest and forces a row on each identity boundary", () => {
    const card = makeWorkerV9Card();
    const compact = buildSafetyScoreCompactCard(card);
    const digest = safetyScoreCompactDigest(compact, identity);
    expect(safetyScoreJournalCardChanged(undefined, digest)).toBe(true);
    expect(safetyScoreJournalCardChanged(digest, safetyScoreCompactDigest(buildSafetyScoreCompactCard(card), identity))).toBe(false);
    expect(safetyScoreJournalCardChanged(digest, safetyScoreCompactDigest({ ...compact, score: 50 }, identity))).toBe(true);
    for (const updated of [
      { ...identity, methodologyVersion: "10.13" }, { ...identity, policyDigest: "c".repeat(64) },
      { ...identity, evaluationBuildDigest: "d".repeat(64) },
    ]) expect(safetyScoreJournalCardChanged(digest, safetyScoreCompactDigest(compact, updated))).toBe(true);
  });

  it("writes first sight, skips identical cards across generations, and records same-grade score changes and releases", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    const fixedInput = makeV9FixedInput({ assetId: "usdc-circle" });
    const card = makeWorkerV9Card({ id: "usdc-circle", score: 84, grade: "A" });
    const publication = makeWorkerSafetyScoreV9Publication({ cards: [card], publishedAtSec: 100 });
    const write = (generation: string, clock: number, cards = [card], policyVersion = publication.policyVersion) => journalSafetyScorePublication({
      db, fixedInput, publication: { ...publication, publicationGenerationId: generation, publishedAtSec: clock, cards, policyVersion },
      attemptId: `attempt:${clock}`, attemptedAtSec: clock, outcome: "accepted",
    });
    try {
      expect(await write("g1", 100)).toEqual({ status: "written", rows: 2 });
      expect(await write("g2", 200)).toEqual({ status: "written", rows: 1 });
      expect(await write("g3", 300, [{ ...card, score: 85 }])).toEqual({ status: "written", rows: 2 });
      expect(await write("g4", 400, [{ ...card, score: 85 }], "10.13")).toEqual({ status: "written", rows: 2 });
      expect(sqlite.prepare("SELECT generation_id, score FROM safety_score_publication_journal ORDER BY published_at").all())
        .toEqual([{ generation_id: "g1", score: 84 }, { generation_id: "g3", score: 85 }, { generation_id: "g4", score: 85 }]);
      expect(sqlite.prepare("SELECT changed_cards, unchanged_cards FROM safety_score_publication_attempts WHERE generation_id = 'g2'").get())
        .toEqual({ changed_cards: 0, unchanged_cards: 1 });
    } finally { sqlite.close(); }
  });

  it("records held identity, reasons and lineage without writing candidate scores", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    const fixedInput = makeV9FixedInput({ assetId: "usdc-circle" });
    try {
      const result = await journalSafetyScorePublication({ db, fixedInput, publication: makeWorkerSafetyScoreV9Publication(),
        attemptId: "held:1", attemptedAtSec: 200, outcome: "held", holdReasons: [{ code: "dex-stale" }] });
      expect(result).toEqual({ status: "written", rows: 1 });
      expect(sqlite.prepare("SELECT outcome, hold_reason_codes_json, changed_cards, unchanged_cards, input_lineage_json FROM safety_score_publication_attempts").get())
        .toMatchObject({ outcome: "held", hold_reason_codes_json: '["dex-stale"]', changed_cards: null, unchanged_cards: null,
          input_lineage_json: expect.stringContaining(fixedInput.dexGenerationId) });
      expect(sqlite.prepare("SELECT COUNT(*) n FROM safety_score_publication_journal").get()).toEqual({ n: 0 });
    } finally { sqlite.close(); }
  });

  it("fails explicitly without inventing a baseline when the journal read throws", async () => {
    const db = mockD1([{ match: "FROM safety_score_publication_journal", rows: [], throwError: new Error("D1 unavailable") }]);
    const result = await journalSafetyScorePublication({ db,
      fixedInput: makeV9FixedInput({ assetId: "usdc-circle" }), publication: makeWorkerSafetyScoreV9Publication(),
      attemptId: "failure:1", attemptedAtSec: 200, outcome: "accepted" });
    expect(result).toEqual({ status: "failed", reason: "journal-write-failed", rows: 0 });
  });

  it("writes a 400-coin release within the existing statement and bind limits", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const publication = makeWorkerSafetyScoreV9Publication({ cards: Array.from({ length: 400 }, (_, i) => makeWorkerV9Card({ id: `coin-${i}` })) });
      const result = await journalSafetyScorePublication({ db, publication, fixedInput: makeV9FixedInput({ assetId: "usdc-circle" }),
        attemptId: "release:1", attemptedAtSec: 200, outcome: "accepted" });
      expect(result).toEqual({ status: "written", rows: 401 });
      expect(sqlite.prepare("SELECT COUNT(*) n FROM safety_score_publication_journal").get()).toEqual({ n: 400 });
    } finally { sqlite.close(); }
  });
});
