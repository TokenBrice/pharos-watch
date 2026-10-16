import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildWorkerStablecoinCatalog,
  renderWorkerStablecoinCatalog,
} from "../build-data/generate-worker-stablecoin-catalog";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const decode = (row: [string, number, string]) => gunzipSync(Buffer.from(row[2], "base64"), {
  maxOutputLength: row[1],
}).toString("utf8");

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
      expect(hash(decode(row))).toBe(hash(JSON.stringify(records[index])));
      expect(JSON.parse(decode(row))).toEqual(records[index]);
    });
  });

});
