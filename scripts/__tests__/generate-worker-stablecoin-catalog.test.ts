import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildWorkerStablecoinCatalog,
  renderWorkerStablecoinCatalog,
} from "../build-data/generate-worker-stablecoin-catalog";

import type { PackedRecord } from "../build-data/generate-worker-stablecoin-catalog";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const decode = (row: PackedRecord) => gunzipSync(Buffer.from(row[2], "base64"), {
  maxOutputLength: row[1],
}).toString("utf8");
const restore = (row: PackedRecord) => {
  const record = JSON.parse(decode(row));
  for (const [field, packed] of Object.entries(row[3] ?? {})) {
    record[field] = JSON.parse(gunzipSync(Buffer.from(packed[1], "base64"), {
      maxOutputLength: packed[0],
    }).toString("utf8"));
  }
  return record;
};

describe("lossless Worker full catalog generator", () => {
  it("preserves complete records, explicit nulls, source order, and deterministic bytes", () => {
    const records = [
      { id: "z", status: "frozen", evidence: { note: "€ 🪙", empty: null, list: [false, 0, ""] } },
      { id: "a", liveReservesConfig: { suspended: true }, extra: { anyFutureField: "retained" } },
    ];
    const artifact = buildWorkerStablecoinCatalog(records);
    expect(artifact.coins.map((row) => row[0])).toEqual(["z", "a"]);
    expect(artifact.coins.map((row) => JSON.parse(decode(row)))).toEqual(records);
    expect(artifact.maxUncompressedBytes).toBe(Math.max(...artifact.coins.map((row) => row[1])));
    expect(renderWorkerStablecoinCatalog(records)).toBe(renderWorkerStablecoinCatalog(records));
    for (const row of artifact.coins) {
      expect(Buffer.from(decode(row), "utf8").length).toBe(row[1]);
      expect(Buffer.from(row[2], "base64").subarray(4, 8)).toEqual(Buffer.alloc(4));
    }
  });

  it("separates complete reviews while retaining metadata and all source links losslessly", () => {
    const review = {
      reviewedStatus: "possible", sources: [{ label: "Pinned source", url: "https://example.com/block/123" }],
      evidence: "Long evidence \u20ac ".repeat(100), reviewedAt: "2026-10-01", reviewer: "reviewer",
    };
    const record = {
      id: "fixture", blacklistabilityReview: review, mintAuthority: { evidence: review.evidence, paths: [review] },
      bridgeRouteRisk: { routes: [review] }, oracleRisk: { paths: [review] }, genius: { issuerEntity: "Fixture", sources: review.sources },
    };
    const artifact = buildWorkerStablecoinCatalog([record]);
    expect(artifact.version).toBe(2);
    expect(JSON.parse(decode(artifact.coins[0]))).toEqual({
      ...record, blacklistabilityReview: null, mintAuthority: null, bridgeRouteRisk: null, oracleRisk: null, genius: null,
    });
    expect(restore(artifact.coins[0])).toEqual(record);
    expect(record.blacklistabilityReview.evidence).toBe(review.evidence);
    expect(artifact.maxUncompressedBytes).toBeGreaterThanOrEqual(Buffer.byteLength(review.evidence));
    expect(renderWorkerStablecoinCatalog([record])).toBe(renderWorkerStablecoinCatalog([record]));
  });

  it("rejects an empty source catalog before building or rendering an artifact", () => {
    expect(() => buildWorkerStablecoinCatalog([])).toThrow("Cannot generate an empty Worker stablecoin catalog");
    expect(() => renderWorkerStablecoinCatalog([])).toThrow("Cannot generate an empty Worker stablecoin catalog");
  });

  it("matches every canonical source record and serialized hash without lifecycle normalization", () => {
    const records = JSON.parse(readFileSync(new URL("../../shared/data/stablecoins/coins.generated.json", import.meta.url), "utf8"));
    const artifact = buildWorkerStablecoinCatalog(records);
    expect(artifact.coins).toHaveLength(records.length);
    artifact.coins.forEach((row, index) => {
      expect(row[0]).toBe(records[index].id);
      expect(hash(JSON.stringify(restore(row)))).toBe(hash(JSON.stringify(records[index])));
      expect(restore(row)).toEqual(records[index]);
    });
  });

});
