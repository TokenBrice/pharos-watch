import { afterEach, describe, expect, it } from "vitest";
import {
  loadV9CandidateMethodologyPolicy,
  loadV9MethodologyPolicy,
  V9_CANDIDATE_POLICY_V1,
} from "@shared/lib/safety-score-v9/policy";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
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
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    toBlockHash: BLOCK_HASH,
    windowStartSec: input.windowStartSec,
    windowEndSec: input.windowEndSec,
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
  it("selects only the requested set even when a foreign set has a newer head", async () => {
    const { db } = fixtures.open();
    const [current] = chain();
    const foreign = { ...chain()[1], screeningPolicyDigest: "f".repeat(64), toBlock: 999 };
    await persistLaneIncidentCertificates(db, [current, foreign].map((certificate) => ({
      certificate, contributorControlIds: ["fixture-owner"],
    })), NOW);
    expect(expectCurrent(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW })).certificate).toEqual(current);
    expect((await loadLaneIncidentCertificate(db, { ...target(), screeningSetId: "0".repeat(64) }, { nowSec: NOW })).state).toBe("missing");
  });
  it("round trips one certificate as a canonical cache row", async () => {
    const { db, sqlite } = fixtures.open();
    const [first] = chain();
    await expect(persistLaneIncidentCertificates(db, [first].map((certificate) => ({ certificate, contributorControlIds: ["fixture-owner"] })), NOW))
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
  });

  it("accepts a contiguous chain and reports its full coverage", async () => {
    const { db } = fixtures.open();
    const [first, second] = chain();
    await persistLaneIncidentCertificates(db, [first, second].map((certificate) => ({ certificate, contributorControlIds: ["fixture-owner"] })), NOW);

    const read = expectCurrent(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW }));
    expect(read.certificate).toEqual(second);
    expect(read.coveredFromSec).toBe(NOW - 4_000);
    expect(read.coveredThroughSec).toBe(NOW - 2_000);
    expect(read.windowCount).toBe(2);
  });

  it("rejects a lane whose retained windows leave an unscreened gap", async () => {
    const { db } = fixtures.open();
    const [first] = chain();
    const afterGap = certificate({
      fromBlock: 202,
      toBlock: 400,
      windowStartSec: NOW - 1_999,
      windowEndSec: NOW - 1_000,
    });
    await persistLaneIncidentCertificates(db, [first, afterGap].map((certificate) => ({ certificate, contributorControlIds: ["fixture-owner"] })), NOW);

    const read = await loadLaneIncidentCertificate(db, target(), { nowSec: NOW });
    expect(read.state).toBe("coverage-gap");
    if (read.state !== "coverage-gap") throw new Error(`Expected a coverage gap, got ${read.state}`);
    expect(read.gapFromBlock).toBe(200);
    expect(read.gapToBlock).toBe(202);
    expect(read.certificate).toEqual(afterGap);
  });

  it("expires strictly after the pinned window end plus the supplied budget and never re-dates the row", async () => {
    const { db, sqlite } = fixtures.open();
    const policy = (() => {
      const raw = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
      raw.semantic.evidence.laneIncidentCertificateMaxAgeSec = 3_600;
      return loadV9MethodologyPolicy(raw, NOW);
    })();
    const only = certificate({
      fromBlock: 100,
      toBlock: 200,
      windowStartSec: NOW - 7_200,
      windowEndSec: NOW - 3_600,
    });
    await persistLaneIncidentCertificates(db, [only].map((certificate) => ({ certificate, contributorControlIds: ["fixture-owner"] })), NOW);
    const before = sqlite.prepare("SELECT value, updated_at FROM cache").get();

    const atBoundary = expectCurrent(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW, policy }));
    expect(atBoundary.expiresAtSec).toBe(NOW);

    const expired = await loadLaneIncidentCertificate(db, target(), { nowSec: NOW + 1, policy });
    expect(expired.state).toBe("expired");
    if (expired.state !== "expired") throw new Error(`Expected expiry, got ${expired.state}`);
    expect(expired.expiredBySec).toBe(1);
    expect(expired.expiresAtSec).toBe(NOW);
    expect(sqlite.prepare("SELECT value, updated_at FROM cache").get()).toEqual(before);
  });

  it("uses the candidate policy budget when no envelope is supplied", async () => {
    const { db } = fixtures.open();
    const maxAgeSec = resolveLaneIncidentCertificateMaxAgeSec(
      loadV9CandidateMethodologyPolicy(NOW),
      NOW,
    );
    expect(maxAgeSec).toBe(2_592_000);
    const only = certificate({
      fromBlock: 100,
      toBlock: 200,
      windowStartSec: NOW - maxAgeSec - 1_000,
      windowEndSec: NOW - maxAgeSec,
    });
    await persistLaneIncidentCertificates(db, [only].map((certificate) => ({ certificate, contributorControlIds: ["fixture-owner"] })), NOW);

    expect(expectCurrent(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW })).expiresAtSec)
      .toBe(NOW);
    expect((await loadLaneIncidentCertificate(db, target(), { nowSec: NOW + 1 })).state).toBe("expired");
  });

  it("fails a lane closed on a malformed stored row", async () => {
    const { db, sqlite } = fixtures.open();
    const only = certificate({
      fromBlock: 100,
      toBlock: 200,
      windowStartSec: NOW - 2_000,
      windowEndSec: NOW - 1_000,
    });
    const key = laneIncidentCertificateCacheKey({ ...only, contributorControlIds: ["fixture-owner"] });
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");

    insert.run(key, JSON.stringify({ schemaVersion: 1 }), NOW);
    const invalidSchema = await loadLaneIncidentCertificate(db, target(), { nowSec: NOW });
    expect(invalidSchema.state).toBe("malformed-row");
    if (invalidSchema.state !== "malformed-row") throw new Error(`Expected malformed row, got ${invalidSchema.state}`);
    expect(invalidSchema.cacheKey).toBe(key);

    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run("{not json", key);
    expect((await loadLaneIncidentCertificate(db, target(), { nowSec: NOW })).state).toBe("malformed-row");
  });

  it("throws when the D1 read fails instead of reporting a clean lane", async () => {
    const db = mockD1([{
      match: "SELECT key FROM cache WHERE key >=",
      rows: [],
      throwError: new Error("d1 unavailable"),
    }]);
    await expect(loadLaneIncidentCertificate(db, target(), { nowSec: NOW }))
      .rejects.toThrow("d1 unavailable");
  });

  it("refuses to store a certificate that fails the C3 schema", async () => {
    const { db, sqlite } = fixtures.open();
    const only = certificate({
      fromBlock: 100,
      toBlock: 200,
      windowStartSec: NOW - 2_000,
      windowEndSec: NOW - 1_000,
    });
    const broken = { ...only, toBlockHash: "0x1234" } as unknown as V9LaneIncidentCertificate;
    await expect(persistLaneIncidentCertificates(db, [broken].map((certificate) => ({ certificate, contributorControlIds: ["fixture-owner"] })), NOW)).rejects.toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
  });

  it("reports missing for an unpersisted lane inside the batch map", async () => {
    const { db } = fixtures.open();
    const [first] = chain();
    await persistLaneIncidentCertificates(db, [first].map((certificate) => ({ certificate, contributorControlIds: ["fixture-owner"] })), NOW);

    const reads = await loadLaneIncidentCertificates(db, [target(), { ...target(), deploymentKey: OTHER_LANE }], { nowSec: NOW });
    expect(reads.get(LANE)?.state).toBe("current");
    expect(reads.get(OTHER_LANE)).toEqual({ state: "missing", deploymentKey: OTHER_LANE });
  });

  it("prunes only the oldest windows of a contiguous group and keeps serving the chain", async () => {
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
      const result = await persistLaneIncidentCertificates(db, [window].map((certificate) => ({ certificate, contributorControlIds: ["fixture-owner"] })), NOW);
      if (index >= LANE_INCIDENT_CERTIFICATE_MAX_WINDOWS_PER_GROUP) expect(result.pruned).toBe(1);
    }

    const read = expectCurrent(await loadLaneIncidentCertificate(db, target(), { nowSec: NOW }));
    expect(read.windowCount).toBe(LANE_INCIDENT_CERTIFICATE_MAX_WINDOWS_PER_GROUP);
    expect(read.coveredFromSec).toBe(windows[2]?.windowStartSec);
    expect(read.certificate).toEqual(windows[windows.length - 1]);
  });

});
