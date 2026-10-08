import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { countV9EvidenceObligations } from "@shared/types/safety-score-v9-public-evidence-facts";
import { ReportCardsV9ResponseSchema } from "@shared/types/report-cards-v9";
import { handleSnapshotCoin, handleSnapshotDay } from "../snapshot";
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

describe("historical snapshot recorded safety contracts", () => {
  it("serves real-shaped 10.09/report7 bytes and ETag without upgrading counts or routes", async () => {
    const { row, payload } = snapshotRow();
    expect(ReportCardsV9ResponseSchema.safeParse(historicalSnapshot.reportCards).success).toBe(false);
    const response = await handleSnapshotDay(database(row), historicalSnapshot.snapshotDate);
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(`"${row.content_hash}"`);
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
});
