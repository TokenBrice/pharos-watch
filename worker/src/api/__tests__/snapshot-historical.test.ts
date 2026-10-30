import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { countV9EvidenceObligations } from "@shared/types/safety-score-v9-public-evidence-facts";
import { HistoricalResolvedReportCardsV9ResponseSchema, HistoricalTypedReportCardsV9ResponseSchema } from "@shared/types/report-cards-v9";
import { ReportCardsV9ResponseSchema } from "@shared/types/report-cards-v9-current";
import { ReportCardsV9AcceptedResponseSchema } from "@shared/types/report-cards-v9-accepted";
import { makeWorkerReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { handleSnapshotCoin, handleSnapshotDay, handleSnapshotsIndex } from "../snapshot";
import historicalSnapshot from "./fixtures/snapshot-2026-10-07-v10.09.json";

type HistoricalSnapshotRow = {
  payload_gz: Uint8Array;
  methodology_versions: string;
  content_hash: string;
  byte_size: number;
  created_at: number;
};

// Two production cards (including their upstream closure) extracted read-only
// from 2026-10-07. Membership/counts/graph and foreign-gap indices are projected;
// identity, witnesses, summaries, route shapes and referenced gaps are retained.
function snapshotRow(envelope = structuredClone(historicalSnapshot)) {
  const payload = JSON.stringify(envelope);
  const hash = createHash("sha256").update(payload).digest("hex");
  return {
    payload,
    row: {
      payload_gz: gzipSync(payload),
      methodology_versions: JSON.stringify({
        ...envelope.methodologyVersions,
        safetyScoreIdentity: envelope.safetyScoreIdentity,
      }),
      content_hash: hash,
      byte_size: Buffer.byteLength(payload),
      created_at: envelope.generatedAt,
    },
  };
}

function database(row: HistoricalSnapshotRow) {
  return mockD1([{ match: "FROM public_snapshots", rows: [row] }]);
}

function setMethodology(envelope: typeof historicalSnapshot, version: string) {
  envelope.methodologyVersions.reportCard = version;
  envelope.safetyScoreIdentity.methodologyVersion = version;
  envelope.reportCards.safetyScoreIdentity.methodologyVersion = version;
  envelope.reportCards.methodology.version = version;
}

/** Modeled 10.28 archive: retain recorded inline controls, add distinct fixture-only typed route IDs. */
function historicalTypedSnapshot() {
  const envelope = structuredClone(historicalSnapshot);
  setMethodology(envelope, "10.28");
  envelope.reportCards.schemaVersion = 8;
  for (const card of envelope.reportCards.cards) {
    const evidence = card.scoreTrace.evidenceResponsibility;
    for (const summary of evidence.summaries) {
      const facts = evidence.facts.filter(fact => fact[3] === summary.responsibility);
      Object.assign(summary, countV9EvidenceObligations(facts, fact => fact[2] as number | null,
        fact => fact[6] as number[], fact => fact[4] as boolean));
    }
    const exit = card.breakdowns.exit;
    for (const [index, route] of [exit.primaryRoute, ...exit.alternatives].entries()) {
      if (route !== null) Object.assign(route, {
        routeId: `fixture:archive:${card.id}:route:${index}`, lane: route.routeFamily === "dex-amm" ? "dex" : "redemption",
      });
    }
  }
  return envelope;
}

/** Modeled 10.29–10.36 archive: report8 resolved cards with no open-evidence block. */
function historicalResolvedSnapshot(version = "10.30") {
  const envelope = structuredClone(historicalSnapshot);
  // Report8 archives predate both the block and the report9-only reason key.
  const { openEvidence: _liveBlock, openEvidenceUnavailableReason: _liveReason, ...report } =
    structuredClone(makeWorkerReportCardsV9Response());
  // The imported JSON fixture infers literal archive types; the archive row is
  // re-parsed at request time, so this modeled payload is a fixture shape only.
  envelope.reportCards = {
    ...report,
    schemaVersion: 8,
    methodology: { ...report.methodology, version },
    safetyScoreIdentity: { ...report.safetyScoreIdentity, methodologyVersion: version },
  } as unknown as typeof envelope.reportCards;
  envelope.methodologyVersions.reportCard = version;
  envelope.safetyScoreIdentity = envelope.reportCards.safetyScoreIdentity;
  return envelope;
}

describe("historical snapshot recorded safety contracts", () => {
  it("serves real-shaped 10.09/report7 bytes and ETag without upgrading counts or routes", async () => {
    const { row, payload } = snapshotRow();
    expect(ReportCardsV9ResponseSchema.safeParse(historicalSnapshot.reportCards).success).toBe(false);
    const response = await handleSnapshotDay(database(row), historicalSnapshot.snapshotDate);
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(`"${row.content_hash}"`);
    expect(await response.text()).toBe(payload);
  });

  it("serves a report9 archived snapshot byte-for-byte", async () => {
    const envelope = structuredClone(historicalSnapshot);
    const reportCards = makeWorkerReportCardsV9Response();
    Object.assign(envelope, {
      reportCards,
      safetyScoreIdentity: reportCards.safetyScoreIdentity,
    });
    envelope.methodologyVersions.reportCard = reportCards.methodology.version;
    expect(ReportCardsV9AcceptedResponseSchema.safeParse(reportCards).success).toBe(true);
    const { row, payload } = snapshotRow(envelope as unknown as typeof historicalSnapshot);
    const response = await handleSnapshotDay(database(row), envelope.snapshotDate);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(payload);
  });

  it("preserves the recorded identity and original card in coin projections", async () => {
    const { row } = snapshotRow();
    const response = await handleSnapshotCoin(database(row), historicalSnapshot.snapshotDate, "armusdcs-wintermute");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      safetyScoreIdentity: historicalSnapshot.safetyScoreIdentity,
      scores: { reportCard: historicalSnapshot.reportCards.cards[0] },
    });
  });

  it("dispatches 10.10/report7 to distinct-obligation accounting with legacy routes", async () => {
    const envelope = structuredClone(historicalSnapshot);
    setMethodology(envelope, "10.10");
    for (const card of envelope.reportCards.cards) {
      const evidence = card.scoreTrace.evidenceResponsibility;
      for (const summary of evidence.summaries) {
        const facts = evidence.facts.filter((fact) => fact[3] === summary.responsibility);
        const counts = countV9EvidenceObligations(facts, (fact) => fact[2] as number | null,
          (fact) => fact[6] as number[], (fact) => fact[4] as boolean);
        Object.assign(summary, counts);
      }
    }
    const { row } = snapshotRow(envelope);
    expect((await handleSnapshotDay(database(row), envelope.snapshotDate)).status).toBe(200);
  });

  it("serves a modeled 10.28/report8 archive with inline control details without rewriting bytes or identity", async () => {
    const envelope = historicalTypedSnapshot();
    expect(envelope.reportCards.cards.some(card =>
      card.breakdowns.control.components.some(component => component.controlDetails.length > 0))).toBe(true);
    expect(HistoricalTypedReportCardsV9ResponseSchema.safeParse(envelope.reportCards).success).toBe(true);
    expect(ReportCardsV9ResponseSchema.safeParse(envelope.reportCards).success).toBe(false);
    const { row, payload } = snapshotRow(envelope);
    const day = await handleSnapshotDay(database(row), envelope.snapshotDate);
    expect(day.status).toBe(200);
    expect(day.headers.get("ETag")).toBe(`"${row.content_hash}"`);
    expect(await day.text()).toBe(payload);
    const coin = await handleSnapshotCoin(database(row), envelope.snapshotDate, "armusdcs-wintermute");
    expect(coin.status).toBe(200);
    expect(await coin.json()).toMatchObject({
      safetyScoreIdentity: envelope.safetyScoreIdentity,
      scores: { reportCard: envelope.reportCards.cards[0] },
    });
  });

  it("does not admit legacy inline-control report8 under the current 10.29 contract", async () => {
    const envelope = historicalTypedSnapshot();
    setMethodology(envelope, "10.29");
    expect(HistoricalTypedReportCardsV9ResponseSchema.safeParse(envelope.reportCards).success).toBe(false);
    const { row } = snapshotRow(envelope);
    expect((await handleSnapshotDay(database(row), envelope.snapshotDate)).status).toBe(500);
  });

  it.each(["10.29", "10.30", "10.37"])(
    "serves every archived 10.29+ report8 snapshot through the resolved historical schema (%s)", async version => {
      const envelope = historicalResolvedSnapshot(version);
      expect(HistoricalResolvedReportCardsV9ResponseSchema.safeParse(envelope.reportCards).success).toBe(true);
      expect(ReportCardsV9ResponseSchema.safeParse(envelope.reportCards).success).toBe(false);
      const { row, payload } = snapshotRow(envelope);
      const day = await handleSnapshotDay(database(row), envelope.snapshotDate);
      expect(day.status).toBe(200);
      expect(day.headers.get("ETag")).toBe(`"${row.content_hash}"`);
      expect(await day.text()).toBe(payload);
      const coin = await handleSnapshotCoin(database(row), envelope.snapshotDate, envelope.reportCards.cards[0]!.id);
      expect(coin.status).toBe(200);
      expect(await coin.json()).toMatchObject({
        safetyScoreIdentity: envelope.safetyScoreIdentity,
        scores: { reportCard: envelope.reportCards.cards[0] },
      });
    });

  it("serves an archived report5 row under the contract it recorded", async () => {
    // Report wire 5 was live while methodology 9.49 was current; the archive
    // row predates report7 and must stay readable byte-for-byte.
    const identity = {
      model: "v9",
      schemaVersion: 1,
      methodologyVersion: "9.49",
      policyId: "safety-score-v9",
      policyDigest: "a".repeat(64),
      evaluationBuildDigest: "b".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:1",
    } as const;
    const card = { id: "usdc-circle", score: 80, grade: "A-" };
    const envelope = {
      snapshotDate: "2026-09-15",
      generatedAt: 1789000000,
      methodologyVersions: { reportCard: "9.49" },
      safetyScoreIdentity: identity,
      stablecoins: [{
        id: "usdc-circle", name: "USD Coin", symbol: "USDC", pegType: "peggedUSD",
        pegMechanism: "fiat-backed", price: 1, circulating: { peggedUSD: 50_000_000_000 }, chains: ["Ethereum"],
      }],
      fxFallbackRates: null,
      reportCards: {
        model: "v9",
        lifecycle: "active",
        safetyScoreIdentity: identity,
        methodology: { version: "9.49", policy: { id: "safety-score-v9", semanticDigest: "a".repeat(64) } },
        asOfSec: 1788999000,
        updatedAt: 1789000000,
        completeness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, notRatedIds: [] },
        source: {
          candidateId: "candidate-v9.49", factSetDigest: "d".repeat(64), resultDigest: "e".repeat(64),
          sourceGenerations: { registry: "registry-1" },
        },
        dependencyGraph: { edges: [] },
        schemaVersion: 5,
        publicationHealth: {
          schemaVersion: 1, status: "current", acceptedPublicationGenerationId: "report-cards:v9:1",
          acceptedAtSec: 1789000000, attemptedAtSec: 1789000000, heldSinceSec: null, reasons: [],
        },
        cards: [card],
      },
    };
    const payload = JSON.stringify(envelope);
    const row = {
      snapshot_date: envelope.snapshotDate,
      payload_gz: gzipSync(payload),
      methodology_versions: JSON.stringify({
        ...envelope.methodologyVersions,
        safetyScoreIdentity: identity,
      }),
      content_hash: createHash("sha256").update(payload).digest("hex"),
      byte_size: Buffer.byteLength(payload),
      created_at: envelope.generatedAt,
    };
    const db = database(row);

    const index = await handleSnapshotsIndex(db);
    expect(index.status).toBe(200);
    expect((await index.json() as { snapshots: Array<{ snapshotDate: string }> }).snapshots)
      .toContainEqual(expect.objectContaining({ snapshotDate: envelope.snapshotDate }));

    const day = await handleSnapshotDay(db, envelope.snapshotDate);
    expect(day.status).toBe(200);
    expect(day.headers.get("ETag")).toBe(`"${row.content_hash}"`);
    expect(await day.text()).toBe(payload);

    const coin = await handleSnapshotCoin(db, envelope.snapshotDate, card.id);
    expect(coin.status).toBe(200);
    expect(await coin.json()).toMatchObject({
      snapshotDate: envelope.snapshotDate,
      stablecoinId: card.id,
      safetyScoreIdentity: identity,
      scores: { reportCard: card },
    });
  });


  it("does not accept witness summaries under the 10.10 accounting contract", async () => {
    const envelope = structuredClone(historicalSnapshot);
    setMethodology(envelope, "10.10");
    const { row } = snapshotRow(envelope);
    expect((await handleSnapshotDay(database(row), envelope.snapshotDate)).status).toBe(500);
  });

  it("does not accept historical report7 as a 10.11 publication", async () => {
    const envelope = structuredClone(historicalSnapshot);
    setMethodology(envelope, "10.11");
    const { row } = snapshotRow(envelope);
    expect((await handleSnapshotDay(database(row), envelope.snapshotDate)).status).toBe(500);
  });

  it("still rejects an identity mismatch across metadata, envelope and report cards", async () => {
    const { row } = snapshotRow();
    const metadata = JSON.parse(row.methodology_versions);
    metadata.safetyScoreIdentity.evaluationBuildDigest = "0".repeat(64);
    row.methodology_versions = JSON.stringify(metadata);
    const response = await handleSnapshotDay(database(row), historicalSnapshot.snapshotDate);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Snapshot safety identity corrupted" });
  });

  it("still rejects corrupt historical witness counts and card scores", async () => {
    const envelope = structuredClone(historicalSnapshot);
    envelope.reportCards.cards[0].scoreTrace.evidenceResponsibility.totalFactCount += 1;
    const { row } = snapshotRow(envelope);
    expect((await handleSnapshotDay(database(row), envelope.snapshotDate)).status).toBe(500);

    const badScore = structuredClone(historicalSnapshot);
    badScore.reportCards.cards[0].score += 10;
    const corrupt = snapshotRow(badScore);
    expect((await handleSnapshotDay(database(corrupt.row), badScore.snapshotDate)).status).toBe(500);
  });

  it.each(["wrapper-discount", "route-eligibility"] as const)("validates recorded %s arithmetic without applying the simplified live model", async mutation => {
    const envelope = structuredClone(historicalSnapshot);
    const card = envelope.reportCards.cards[0]!;
    if (mutation === "wrapper-discount") {
      if (card.scoreTrace.wrapperParentLimit === null) throw new Error("Historical wrapper fixture is required");
      card.scoreTrace.wrapperParentLimit.localRiskDiscount += 1;
    } else {
      if (card.breakdowns.exit.primaryRoute === null) throw new Error("Historical route fixture is required");
      card.breakdowns.exit.primaryRoute.eligibilityMultiplier = 0;
    }
    const { row } = snapshotRow(envelope);
    expect((await handleSnapshotDay(database(row), envelope.snapshotDate)).status).toBe(500);
  });
});
