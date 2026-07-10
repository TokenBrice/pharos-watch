import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  buildSupplySnapshotCoverageExpectation,
  getCompletedSupplySnapshot,
} from "../supply-snapshot-completion";
import type { StablecoinPublicationWaiver } from "../stablecoin-publication-coverage";

const SNAPSHOT_DATE = Date.UTC(2026, 6, 10) / 1000;

function markerRow(value: Record<string, unknown>) {
  return {
    key: "snapshot-supply:last-write",
    value: JSON.stringify(value),
    updated_at: SNAPSHOT_DATE + 60,
  };
}

describe("supply snapshot completion identity", () => {
  it("is order-independent but changes for a same-count ID replacement", () => {
    const first = buildSupplySnapshotCoverageExpectation(["coin-b", "coin-a"], []);
    const reordered = buildSupplySnapshotCoverageExpectation(["coin-a", "coin-b"], []);
    const replaced = buildSupplySnapshotCoverageExpectation(["coin-a", "coin-c"], []);

    expect(first).toEqual(reordered);
    expect(first.expectedActiveCount).toBe(2);
    expect(first.coverageDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(replaced.expectedActiveCount).toBe(first.expectedActiveCount);
    expect(replaced.coverageDigest).not.toBe(first.coverageDigest);
  });

  it("binds an applied waiver's stablecoin identity, owner, and expiry", () => {
    const waiver: StablecoinPublicationWaiver = {
      stablecoinId: "coin-b",
      owner: "data-platform",
      reason: "upstream unavailable",
      expiresAt: SNAPSHOT_DATE + 3600,
    };
    const baseline = buildSupplySnapshotCoverageExpectation(["coin-a", "coin-b"], [waiver]);

    expect(buildSupplySnapshotCoverageExpectation(
      ["coin-a", "coin-b"],
      [{ ...waiver, owner: "data-operations" }],
    ).coverageDigest).not.toBe(baseline.coverageDigest);
    expect(buildSupplySnapshotCoverageExpectation(
      ["coin-a", "coin-b"],
      [{ ...waiver, expiresAt: waiver.expiresAt + 1 }],
    ).coverageDigest).not.toBe(baseline.coverageDigest);
    expect(buildSupplySnapshotCoverageExpectation(
      ["coin-a", "coin-b"],
      [{ ...waiver, stablecoinId: "coin-a" }],
    ).coverageDigest).not.toBe(baseline.coverageDigest);
  });

  it("keeps v1 markers readable but never treats their count equality as exact", async () => {
    const db = mockD1([{
      match: "cache",
      matchBinds: ["snapshot-supply:last-write"],
      rows: [markerRow({
        snapshotDate: SNAPSHOT_DATE,
        coverageVersion: 1,
        expectedActiveCount: 2,
        accountedActiveCount: 2,
        ownedRowIds: ["coin-a", "coin-b"],
      })],
    }]);

    await expect(getCompletedSupplySnapshot(db)).resolves.toMatchObject({
      snapshotDate: SNAPSHOT_DATE,
      exactCoverageVerified: false,
      ownedRowIds: null,
    });
  });

  it("requires the current exact expectation and canonical ownership proof", async () => {
    const expectedCoverage = buildSupplySnapshotCoverageExpectation(["coin-a", "coin-b"], []);
    const db = mockD1([{
      match: "cache",
      matchBinds: ["snapshot-supply:last-write"],
      rows: [markerRow({
        snapshotDate: SNAPSHOT_DATE,
        coverageVersion: 2,
        ...expectedCoverage,
        accountedActiveCount: 2,
        ownedRowIds: ["coin-a", "coin-b"],
      })],
    }]);

    await expect(getCompletedSupplySnapshot(db, { expectedCoverage })).resolves.toMatchObject({
      exactCoverageVerified: true,
      ownedRowIds: ["coin-a", "coin-b"],
    });

    const changedCoverage = buildSupplySnapshotCoverageExpectation(["coin-a", "coin-c"], []);
    await expect(getCompletedSupplySnapshot(db, { expectedCoverage: changedCoverage })).resolves.toMatchObject({
      exactCoverageVerified: false,
    });
  });
});
