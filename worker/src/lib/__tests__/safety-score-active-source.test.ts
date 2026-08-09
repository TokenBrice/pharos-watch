import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";

/**
 * The unavailable case stays a real end-to-end read against an empty schema;
 * the current/held projection is driven through this override so both arms of
 * the one canonical loader are covered in one place.
 */
const mocks = vi.hoisted(() => ({
  snapshotOverride: null as null | (() => Promise<ReportCardsV9CurrentResponse>),
}));

vi.mock("../report-cards-v9-cache", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../report-cards-v9-cache")>();
  return {
    ...actual,
    loadPublishedReportCardsV9Snapshot: (db: D1Database, signal?: AbortSignal) =>
      mocks.snapshotOverride
        ? mocks.snapshotOverride()
        : actual.loadPublishedReportCardsV9Snapshot(db, signal),
  };
});

const { loadActiveSafetyScoreSource } = await import(
  "../safety-score-active-source"
);

function heldSnapshot(): ReportCardsV9CurrentResponse {
  const current = makeReportCardsV9Response();
  return makeReportCardsV9Response({
    publicationHealth: {
      ...current.publicationHealth,
      status: "held",
      attemptedAtSec: current.updatedAt + 1_800,
      heldSinceSec: current.updatedAt + 1_800,
      reasons: [{ code: "dex-stale" }],
    },
  });
}

describe("active Safety Score source", () => {
  beforeEach(() => {
    mocks.snapshotOverride = null;
  });

  it("fails closed without falling back to V8", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();

    await expect(loadActiveSafetyScoreSource(db)).resolves.toEqual({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail: "Canonical Safety Score V9 publication is unavailable",
    });
    sqlite.close();
  });

  it("projects the canonical active V9 snapshot", async () => {
    const snapshot = makeReportCardsV9Response();
    mocks.snapshotOverride = async () => snapshot;

    await expect(
      loadActiveSafetyScoreSource({} as D1Database),
    ).resolves.toEqual({ kind: "v9", snapshot });
  });

  it("reports a held publication as its own state and keeps the snapshot", async () => {
    const snapshot = heldSnapshot();
    mocks.snapshotOverride = async () => snapshot;

    await expect(
      loadActiveSafetyScoreSource({} as D1Database),
    ).resolves.toEqual({
      kind: "held",
      reason: "v9-publication-held",
      detail:
        "Canonical Safety Score V9 ratings are held at the last verified snapshot",
      snapshot,
    });
  });
});
