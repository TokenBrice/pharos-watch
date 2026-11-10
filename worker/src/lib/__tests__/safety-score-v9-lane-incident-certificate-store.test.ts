import { afterEach, describe, expect, it } from "vitest";
import {
  loadV9MethodologyPolicy,
  V9_CANDIDATE_POLICY_V1,
} from "@shared/lib/safety-score-v9/policy";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  V9LaneIncidentCertificateSchema,
  type V9LaneIncidentCertificate,
} from "@shared/types/safety-score-v9-incidents";
import {
  LANE_INCIDENT_CERTIFICATE_MAX_WINDOWS_PER_GROUP,
  laneIncidentCertificateCacheKey,
  loadLaneIncidentCertificate,
  loadLaneIncidentCertificates,
  persistLaneIncidentCertificates,
  resolveLaneIncidentCertificateMaxAgeSec,
  type LaneIncidentCertificateRead,
} from "../safety-score-v9/lane-incident-certificate-store";
import { laneIncidentCertificateScreeningSetId } from "@shared/lib/safety-score-v9/lane-screening-derivation";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const NOW = Date.parse("2026-10-29T12:00:00.000Z") / 1_000;
const LANE = "ethereum:0x1111111111111111111111111111111111111111";
const OTHER_LANE = "base:0x3333333333333333333333333333333333333333";
const EMITTER = "0x2222222222222222222222222222222222222222";
const TOPIC0 = "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0";
const SHA256 = "a".repeat(64);
const BLOCK_HASH = `0x${"b".repeat(64)}`;

function certificate(input: {
  fromBlock: number;
  toBlock: number;
  windowStartSec: number;
  windowEndSec: number;
}): V9LaneIncidentCertificate {
  return V9LaneIncidentCertificateSchema.parse({
    schemaVersion: 1,
    certificateId: `lane-cert:${input.fromBlock}-${input.toBlock}`,
    evidenceClass: "explorer-events",
    subjectDeploymentKey: LANE,
    ...input,
    toBlockHash: BLOCK_HASH,
    observedAtSec: input.windowEndSec + 60,
    screeningPolicyDigest: SHA256,
    logDigest: SHA256,
    emitters: [{
      address: EMITTER,
      expectedRuntimeCodeSha256: SHA256,
      runtimeCodeSha256: SHA256,
      families: ["OwnershipTransferred"],
    }],
    screenedTopics: [{
      family: "OwnershipTransferred",
      topic0: TOPIC0,
      signature: "OwnershipTransferred(address,address)",
    }],
    eventCounts: { OwnershipTransferred: 0 },
    finding: "no-material-admin-event",
  });
}

function chain(): V9LaneIncidentCertificate[] {
  return [
    certificate({ fromBlock: 100, toBlock: 200, windowStartSec: NOW - 4_000, windowEndSec: NOW - 3_000 }),
    certificate({ fromBlock: 201, toBlock: 300, windowStartSec: NOW - 2_999, windowEndSec: NOW - 2_000 }),
  ];
}

function rows(...certificates: V9LaneIncidentCertificate[]) {
  return certificates.map((certificate) => ({ certificate, contributorControlIds: ["fixture-owner"] }));
}

function target() {
  return { deploymentKey: LANE, screeningSetId: laneIncidentCertificateScreeningSetId({
    ...chain()[0], contributorControlIds: ["fixture-owner"],
  }) };
}

function expectCurrent(read: LaneIncidentCertificateRead) {
  expect(read.state).toBe("current");
  if (read.state !== "current") throw new Error(`Expected a current lane certificate, got ${read.state}`);
  return read;
}

describe("lane incident certificate store", () => {
  it("rejects invalid key components and clocks", async () => {
    const input = { ...chain()[0], contributorControlIds: ["fixture-owner"] };
    for (const fromBlock of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => laneIncidentCertificateCacheKey({ ...input, fromBlock })).toThrow("non-negative safe integer");
    }
    expect(() => laneIncidentCertificateCacheKey({ ...input, subjectDeploymentKey: "bad|lane" })).toThrow("separator");
    await expect(loadLaneIncidentCertificate(mockD1(), target(), { nowSec: -1 })).rejects.toThrow("clock");
  });

  it.each(["bad", "9007199254740992-0000000000000001"])("rejects malformed window key %s", async (window) => {
    const key = `lane-incident-certificate:v1|${LANE}|${target().screeningSetId}|${window}|0000000000000001-0000000000000002`;
    const db = mockD1([{ match: "SELECT key FROM cache WHERE key >=", rows: [{ key }] }]);
    expect(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW })).toMatchObject({
      state: "malformed-row", cacheKey: key, detail: "cache key is not a lane incident certificate identity",
    });
  });

  it("fails closed when a scanned row disappears", async () => {
    const key = laneIncidentCertificateCacheKey({ ...chain()[0], contributorControlIds: ["fixture-owner"] });
    const db = mockD1([
      { match: "SELECT key FROM cache WHERE key >=", rows: [{ key }] },
      { match: "SELECT key, value, updated_at FROM cache WHERE key IN", rows: [] },
    ]);
    expect(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW })).toMatchObject({
      state: "malformed-row", cacheKey: key, detail: expect.stringContaining("disappeared"),
    });
  });

  it("ignores newer foreign sets", async () => {
    const { db } = fixtures.open();
    const [current] = chain();
    const foreign = { ...chain()[1], screeningPolicyDigest: "f".repeat(64), toBlock: 999 };
    await persistLaneIncidentCertificates(db, rows(current, foreign), NOW);
    expect(expectCurrent(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW })).certificate).toEqual(current);
    expect((await loadLaneIncidentCertificate(db, { ...target(), screeningSetId: "0".repeat(64) }, { nowSec: NOW })).state).toBe("missing");
  });
  it("round trips a canonical row", async () => {
    const { db, sqlite } = fixtures.open();
    const [first] = chain();
    await expect(persistLaneIncidentCertificates(db, rows(first), NOW))
      .resolves.toEqual({ written: 1, pruned: 0 });

    const row = sqlite.prepare("SELECT key, value, updated_at FROM cache").get() as {
      key: string;
      value: string;
      updated_at: number;
    };
    expect(row.key).toBe(laneIncidentCertificateCacheKey({ ...first, contributorControlIds: ["fixture-owner"] }));
    expect(row.updated_at).toBe(NOW);
    expect(JSON.parse(row.value)).toEqual(first);

    const read = expectCurrent(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW }));
    expect(read.certificate).toEqual(first);
    expect(read.coveredFromSec).toBe(NOW - 4_000);
    expect(read.coveredThroughSec).toBe(NOW - 3_000);
    expect(read.windowCount).toBe(1);
    expect(read.expiresAtSec).toBe(NOW - 3_000 + 2_592_000);
    expect((await loadLaneIncidentCertificate(db, target(), { nowSec: NOW - 4_000 })).state).toBe("future-window");
  });

  it("reports contiguous coverage", async () => {
    const { db } = fixtures.open();
    const [first, second] = chain();
    await persistLaneIncidentCertificates(db, rows(first, second), NOW);

    const read = expectCurrent(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW }));
    expect(read.certificate).toEqual(second);
    expect(read.coveredFromSec).toBe(NOW - 4_000);
    expect(read.coveredThroughSec).toBe(NOW - 2_000);
    expect(read.windowCount).toBe(2);
  });

  it("rejects unscreened gaps", async () => {
    const { db } = fixtures.open();
    const [first] = chain();
    const afterGap = certificate({
      fromBlock: 202,
      toBlock: 400,
      windowStartSec: NOW - 1_999,
      windowEndSec: NOW - 1_000,
    });
    await persistLaneIncidentCertificates(db, rows(first, afterGap), NOW);

    const read = await loadLaneIncidentCertificate(db, target(), { nowSec: NOW });
    expect(read).toEqual(expect.objectContaining({ state: "coverage-gap", gapFromBlock: 200, gapToBlock: 202, certificate: afterGap }));
  });

  it.each([3_600, 2_592_000])("expires after budget %i without re-dating", async (maxAgeSec) => {
    const { db, sqlite } = fixtures.open();
    const raw = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    raw.semantic.evidence.laneIncidentCertificateMaxAgeSec = maxAgeSec;
    const policy = maxAgeSec === 3_600 ? loadV9MethodologyPolicy(raw, NOW) : undefined;
    expect(resolveLaneIncidentCertificateMaxAgeSec(policy, NOW)).toBe(maxAgeSec);
    const only = certificate({
      fromBlock: 100,
      toBlock: 200,
      windowStartSec: NOW - maxAgeSec - 1_000,
      windowEndSec: NOW - maxAgeSec,
    });
    await persistLaneIncidentCertificates(db, rows(only), NOW);
    const before = sqlite.prepare("SELECT value, updated_at FROM cache").get();

    const atBoundary = expectCurrent(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW, policy }));
    expect(atBoundary.expiresAtSec).toBe(NOW);

    const expired = await loadLaneIncidentCertificate(db, target(), { nowSec: NOW + 1, policy });
    expect(expired).toMatchObject({ state: "expired", expiredBySec: 1, expiresAtSec: NOW });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache").get()).toEqual(before);
  });

  it("rejects malformed stored values", async () => {
    const { db, sqlite } = fixtures.open();
    const [only] = chain();
    const key = laneIncidentCertificateCacheKey({ ...only, contributorControlIds: ["fixture-owner"] });
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");

    insert.run(key, JSON.stringify({ schemaVersion: 1 }), NOW);
    const invalidSchema = await loadLaneIncidentCertificate(db, target(), { nowSec: NOW });
    expect(invalidSchema).toMatchObject({ state: "malformed-row", cacheKey: key });
    for (const [value, detail] of [
      ["{not json", "not valid JSON"],
      [JSON.stringify(only), "not canonical"],
      [stableJsonStringifyV1({ ...only, toBlock: 201 }), "does not match"],
    ]) {
      sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(value, key);
      expect(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW }))
        .toMatchObject({ state: "malformed-row", cacheKey: key, detail: expect.stringContaining(detail) });
    }
  });

  it("throws on failed D1 reads", async () => {
    const db = mockD1([{
      match: "SELECT key FROM cache WHERE key >=",
      rows: [],
      throwError: new Error("d1 unavailable"),
    }]);
    await expect(loadLaneIncidentCertificate(db, target(), { nowSec: NOW }))
      .rejects.toThrow("d1 unavailable");
  });

  it("rejects invalid and conflicting writes", async () => {
    const { db, sqlite } = fixtures.open();
    const [only] = chain();
    const broken = { ...only, toBlockHash: "0x1234" } as unknown as V9LaneIncidentCertificate;
    await expect(persistLaneIncidentCertificates(db, rows(broken), NOW)).rejects.toThrow();
    await expect(persistLaneIncidentCertificates(db, rows(only, { ...only, logDigest: "c".repeat(64) }), NOW))
      .rejects.toThrow("Conflicting");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
  });

  it("reports missing lanes in batch reads", async () => {
    const { db } = fixtures.open();
    const [first] = chain();
    await persistLaneIncidentCertificates(db, rows(first), NOW);

    const reads = await loadLaneIncidentCertificates(db, [target(), { ...target(), deploymentKey: OTHER_LANE }], { nowSec: NOW });
    expect(reads.get(LANE)?.state).toBe("current");
    expect(reads.get(OTHER_LANE)).toEqual({ state: "missing", deploymentKey: OTHER_LANE });
  });

  it("prunes oldest contiguous windows", async () => {
    const { db } = fixtures.open();
    const windows = Array.from({ length: LANE_INCIDENT_CERTIFICATE_MAX_WINDOWS_PER_GROUP + 2 }, (_, index) =>
      certificate({
        fromBlock: 100 + index * 100,
        toBlock: 200 + index * 100,
        windowStartSec: NOW - 10_000 + index * 1_000,
        windowEndSec: NOW - 9_000 + index * 1_000,
      }),
    );
    for (const [index, window] of windows.entries()) {
      const result = await persistLaneIncidentCertificates(db, rows(window), NOW);
      if (index >= LANE_INCIDENT_CERTIFICATE_MAX_WINDOWS_PER_GROUP) expect(result.pruned).toBe(1);
    }

    const read = expectCurrent(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW }));
    expect(read.windowCount).toBe(LANE_INCIDENT_CERTIFICATE_MAX_WINDOWS_PER_GROUP);
    expect(read.coveredFromSec).toBe(windows[2]?.windowStartSec);
    expect(read.certificate).toEqual(windows[windows.length - 1]);
  });

});
