import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  buildDewsStablecoinIdsDigest,
  readDewsPublishedGenerationResult,
} from "../dews-publication-pointer";

const nowSec = 1_778_400_000;
const pointerKey = "dews:published-generation";

function pointerMatch(value: string, updatedAt: number, throwError?: unknown) {
  return {
    match: "FROM cache WHERE key = ?",
    matchBinds: [pointerKey],
    rows: [{
      key: pointerKey,
      value,
      updated_at: updatedAt,
    }],
    first: {
      key: pointerKey,
      value,
      updated_at: updatedAt,
    },
    throwError,
  };
}

function pointerPayload(updatedAt: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    updatedAt,
    source: "compute-dews",
    publishStatus: "published",
    ...overrides,
  });
}

describe("DEWS publication pointer reader", () => {
  it("returns ok for a valid published generation pointer", async () => {
    const db = mockD1([
      pointerMatch(pointerPayload(nowSec - 60), nowSec - 60),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toEqual({
      status: "ok",
      computedAt: nowSec - 60,
      expectedRowCount: null,
      stablecoinIdsDigest: null,
    });
  });

  it("returns exact generation coverage from a current pointer", async () => {
    const computedAt = nowSec - 60;
    const stablecoinIds = ["usdt-tether", "usdc-circle"];
    const db = mockD1([
      pointerMatch(pointerPayload(computedAt, {
        coverageVersion: 2,
        expectedRowCount: stablecoinIds.length,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(stablecoinIds),
      }), computedAt),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toEqual({
      status: "ok",
      computedAt,
      expectedRowCount: 2,
      stablecoinIdsDigest: buildDewsStablecoinIdsDigest(stablecoinIds),
    });
  });

  it("rejects malformed exact-generation coverage", async () => {
    const computedAt = nowSec - 60;
    const db = mockD1([
      pointerMatch(pointerPayload(computedAt, {
        coverageVersion: 2,
        expectedRowCount: 2,
        stablecoinIdsDigest: "not-a-digest",
      }), computedAt),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toMatchObject({
      status: "invalid-pointer",
      reason: "payload stablecoinIdsDigest is not SHA-256",
    });
  });

  it("distinguishes a missing pointer from invalid pointers", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [pointerKey],
        rows: [],
        first: null,
      },
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toEqual({
      status: "no-pointer",
    });
  });

  it("rejects future pointers", async () => {
    const db = mockD1([
      pointerMatch(pointerPayload(nowSec + 60), nowSec + 60),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toMatchObject({
      status: "invalid-pointer",
      reason: "payload updatedAt is in the future",
    });
  });

  it("rejects pointers whose payload timestamp differs from cache updated_at", async () => {
    const db = mockD1([
      pointerMatch(pointerPayload(nowSec - 60), nowSec - 30),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toMatchObject({
      status: "invalid-pointer",
      reason: "payload updatedAt does not match cache updated_at",
    });
  });

  it("classifies D1 read failures separately from invalid payloads", async () => {
    const db = mockD1([
      pointerMatch(pointerPayload(nowSec - 60), nowSec - 60, new Error("D1 unavailable")),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toMatchObject({
      status: "read-failed",
      error: "D1 unavailable",
    });
  });
});
