import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import type * as LaneAdminEventModule from "../../lib/safety-score-v9/bridge-lane-admin-events";
import type {
  V9LaneIncidentCertificate,
  V9LaneIncidentScreeningResult,
} from "@shared/types/safety-score-v9-incidents";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import * as evmRpc from "../../lib/evm-rpc";
import {
  LANE_SCREENING_MAX_BLOCKS_PER_CERTIFICATE,
  laneScreeningAttemptCacheKey,
  parseLaneScreeningAttempt,
  planLaneScreeningWindow,
  selectLaneScreeningCandidates,
  syncV9LaneAdminEvents,
  type LaneScreeningAttempt,
  type LaneScreeningDescriptor,
} from "../sync-v9-lane-admin-events";

import { persistLaneIncidentCertificates } from "../../lib/safety-score-v9/lane-incident-certificate-store";
import { LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST } from "../../lib/safety-score-v9/bridge-lane-admin-events";
const mocks = vi.hoisted(() => ({ screen: vi.fn(), head: vi.fn() }));

vi.mock("../../lib/safety-score-v9/bridge-lane-admin-events", async importOriginal => ({
  ...(await importOriginal<typeof import("../../lib/safety-score-v9/bridge-lane-admin-events")>()),
  screenLaneAdminEvents: mocks.screen,
}));

vi.mock("../../lib/evm-rpc", async importOriginal => ({
  ...(await importOriginal<typeof import("../../lib/evm-rpc")>()),
  fetchEvmBlockHeaderAtTag: mocks.head,
}));

const NOW = 1_800_000_000;
const HEADER = { number: 10_000, timestamp: NOW - 60, hash: `0x${"9".repeat(64)}` } as const;
const EMITTER = {
  address: `0x${"1".repeat(40)}` as `0x${string}`,
  expectedRuntimeCodeSha256: "f".repeat(64),
  families: ["Paused"] as const,
};
const CHAIN_RPCS = new Map<string, ChainRpcConfig>([
  ["ethereum", { chainId: "ethereum", chainName: "Ethereum", type: "evm" } as ChainRpcConfig],
  ["tron", { chainId: "tron", chainName: "Tron", type: "tron" } as ChainRpcConfig],
]);
const LANE = `ethereum:${`0x${"a".repeat(40)}`}`;

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
beforeEach(() => {
  mocks.head.mockResolvedValue(HEADER);
  mocks.screen.mockReset();
});

function descriptor(subjectDeploymentKey = LANE, lookbackBlocks = 1_000): LaneScreeningDescriptor {
  return { subjectDeploymentKey, emitters: [EMITTER], lookbackBlocks, provenance: { controlIds: ["fixture-owner"] } };
}

function certificate(
  lane: string,
  fromBlock: number,
  toBlock: number,
  observedAtSec = NOW,
): V9LaneIncidentCertificate {
  return {
    schemaVersion: 1,
    certificateId: `lane-cert:${lane}:${fromBlock}-${toBlock}:${"a".repeat(12)}`,
    evidenceClass: "explorer-events",
    subjectDeploymentKey: lane,
    fromBlock,
    toBlock,
    toBlockHash: `0x${"b".repeat(64)}`,
    windowStartSec: NOW - 120,
    windowEndSec: NOW - 60,
    observedAtSec,
    screeningPolicyDigest: "c".repeat(64),
    logDigest: "d".repeat(64),
    emitters: [{
      address: EMITTER.address,
      expectedRuntimeCodeSha256: EMITTER.expectedRuntimeCodeSha256,
      runtimeCodeSha256: EMITTER.expectedRuntimeCodeSha256,
      families: ["Paused"],
    }],
    screenedTopics: [{ family: "Paused", topic0: `0x${"e".repeat(64)}`, signature: "Paused(address)" }],
    eventCounts: { Paused: 0 },
    finding: "no-material-admin-event",
  };
}

function admitted(cert: V9LaneIncidentCertificate): V9LaneIncidentScreeningResult {
  return { outcome: "admitted", certificate: cert };
}

function failed(lane: string, failureReason: "pruned-range" | "rpc-unavailable"): V9LaneIncidentScreeningResult {
  return { outcome: "failed", deploymentKey: lane, failureReason, observedAtSec: NOW, detail: "page-refused" };
}

async function readAttempt(db: D1Database, lane = LANE): Promise<LaneScreeningAttempt | null> {
  const row = await db
    .prepare("SELECT value FROM cache WHERE key = ?")
    .bind(laneScreeningAttemptCacheKey(lane))
    .first<{ value: string }>();
  return row ? parseLaneScreeningAttempt(row.value) : null;
}

async function certificateRows(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT count(*) AS count FROM cache WHERE key LIKE 'lane-incident-certificate:v1|%'")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("lane screening window planning", () => {
  it("bootstraps a lane with its descriptor lookback and abuts the newest certified block", () => {
    expect(planLaneScreeningWindow({ descriptor: descriptor(), finalizedHead: HEADER, certifiedToBlock: null }))
      .toEqual({ fromBlock: 9_001, toBlock: 10_000 });
    expect(planLaneScreeningWindow({ descriptor: descriptor(), finalizedHead: HEADER, certifiedToBlock: 5_000 }))
      .toEqual({ fromBlock: 5_001, toBlock: 10_000 });
  });

  it("caps one certificate at the screener page budget and stops at the finalized head", () => {
    expect(planLaneScreeningWindow({
      descriptor: descriptor(),
      finalizedHead: { ...HEADER, number: 1_000_000 },
      certifiedToBlock: null,
    })).toEqual({ fromBlock: 999_001, toBlock: 1_000_000 });
    expect(planLaneScreeningWindow({
      descriptor: { ...descriptor(), lookbackBlocks: 1 },
      finalizedHead: { ...HEADER, number: 1_000_000 },
      certifiedToBlock: 0,
    })).toEqual({ fromBlock: 1, toBlock: LANE_SCREENING_MAX_BLOCKS_PER_CERTIFICATE });
  });

  it("reports a lane already at the finalized head as current", () => {
    expect(planLaneScreeningWindow({ descriptor: descriptor(), finalizedHead: HEADER, certifiedToBlock: 10_000 }))
      .toBeNull();
  });
});

describe("due-lane selection", () => {
  const attempt = (overrides: Partial<LaneScreeningAttempt> & Pick<LaneScreeningAttempt, "subjectDeploymentKey">): LaneScreeningAttempt => ({
    attemptedAtSec: NOW - 10,
    fromBlock: 1,
    toBlock: 2,
    outcome: "admitted",
    certificateId: "lane-cert:fixture",
    consecutiveFailures: 0,
    ...overrides,
  });

  it("orders least-recently-attempted lanes first and defers the rest by reason", () => {
    const lanes = ["ethereum:0xaa", "ethereum:0xbb", "ethereum:0xcc"];
    const result = selectLaneScreeningCandidates({
      descriptors: lanes.map(lane => descriptor(lane)),
      attempts: new Map([
        [lanes[0]!, attempt({ subjectDeploymentKey: lanes[0]!, attemptedAtSec: NOW - 1_000 })],
        [lanes[2]!, attempt({ subjectDeploymentKey: lanes[2]!, attemptedAtSec: NOW - 2_000 })],
      ]),
      certificateStates: new Map(),
      chainTypes: new Map([["ethereum", "evm"]]),
      nowSec: NOW,
      refreshIntervalSec: 0,
    });
    expect(result.candidates.map(row => row.subjectDeploymentKey)).toEqual([lanes[1], lanes[2], lanes[0]]);
    expect(result.deferred).toEqual([]);
  });

  it("never selects a non-EVM chain, a malformed descriptor or a duplicate", () => {
    const duplicate = descriptor("ethereum:0xbb");
    const result = selectLaneScreeningCandidates({
      descriptors: [
        descriptor("tron:0xaa"),
        descriptor(LANE, 0),
        duplicate,
        duplicate,
        descriptor("ethereum:0xcc"),
      ],
      attempts: new Map(),
      certificateStates: new Map(),
      chainTypes: new Map([["ethereum", "evm"], ["tron", "tron"]]),
      nowSec: NOW,
    });
    expect(result.candidates.map(row => row.subjectDeploymentKey)).toEqual(["ethereum:0xbb", "ethereum:0xcc"]);
    expect(result.deferred).toEqual([
      { subjectDeploymentKey: "tron:0xaa", reason: "unsupported-chain" },
      { subjectDeploymentKey: LANE, reason: "invalid-descriptor" },
      { subjectDeploymentKey: "ethereum:0xbb", reason: "duplicate-descriptor" },
    ]);
  });

  it("holds a failed lane through exponential backoff and a successful lane through the refresh window", () => {
    const failedLane = "ethereum:0xaa";
    const recentLane = "ethereum:0xbb";
    const result = selectLaneScreeningCandidates({
      descriptors: [descriptor(failedLane), descriptor(recentLane)],
      attempts: new Map([
        [failedLane, attempt({
          subjectDeploymentKey: failedLane,
          outcome: "failed",
          failureReason: "rpc-unavailable",
          certificateId: undefined,
          attemptedAtSec: NOW - 7_000,
          consecutiveFailures: 2,
        })],
        [recentLane, attempt({ subjectDeploymentKey: recentLane, attemptedAtSec: NOW - 60 })],
      ]),
      certificateStates: new Map(),
      chainTypes: new Map([["ethereum", "evm"]]),
      nowSec: NOW,
      failureBackoffSec: 3_600,
      refreshIntervalSec: 3_600,
    });
    expect(result.candidates).toEqual([]);
    expect(result.deferred).toEqual([
      { subjectDeploymentKey: failedLane, reason: "failure-backoff" },
      { subjectDeploymentKey: recentLane, reason: "not-due" },
    ]);
  });

  it("defers certificate states that need a data repair instead of spending RPC budget", () => {
    const lanes = ["ethereum:0xaa", "ethereum:0xbb", "ethereum:0xcc"];
    const result = selectLaneScreeningCandidates({
      descriptors: lanes.map(lane => descriptor(lane)),
      attempts: new Map(),
      certificateStates: new Map([
        [lanes[0]!, "coverage-gap"],
        [lanes[1]!, "malformed-row"],
        [lanes[2]!, "future-window"],
      ]),
      chainTypes: new Map([["ethereum", "evm"]]),
      nowSec: NOW,
    });
    expect(result.candidates).toEqual([]);
    expect(result.deferred.map(row => row.reason)).toEqual([
      "certificate-coverage-gap",
      "certificate-malformed",
      "certificate-future-window",
    ]);
  });
});

describe("lane screening attempt records", () => {
  it("requires a certificate for admitted attempts and a machine reason for failures", () => {
    const base = {
      subjectDeploymentKey: LANE,
      attemptedAtSec: NOW,
      fromBlock: 1,
      toBlock: 2,
      consecutiveFailures: 0,
    };
    expect(parseLaneScreeningAttempt(JSON.stringify({ ...base, outcome: "admitted", certificateId: "lane-cert:x" })))
      .toMatchObject({ outcome: "admitted", certificateId: "lane-cert:x" });
    expect(parseLaneScreeningAttempt(JSON.stringify({ ...base, outcome: "admitted" }))).toBeNull();
    expect(parseLaneScreeningAttempt(JSON.stringify({ ...base, outcome: "failed", certificateId: "lane-cert:x", failureReason: "rpc-unavailable" })))
      .toBeNull();
    expect(parseLaneScreeningAttempt(JSON.stringify({ ...base, outcome: "failed" }))).toBeNull();
    expect(parseLaneScreeningAttempt("not-json")).toBeNull();
  });
});

describe("syncV9LaneAdminEvents", () => {
  it("resumes the contributor-bound v2 certificate chain without an attempt backoff", async () => {
    const { db } = fixtures.open();
    const prior = { ...certificate(LANE, 4_001, 5_000), screeningPolicyDigest: LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST };
    await persistLaneIncidentCertificates(db, [{ certificate: prior, contributorControlIds: descriptor().provenance.controlIds }], NOW);
    expect(await readAttempt(db)).toBeNull();
    mocks.screen.mockResolvedValue(admitted({
      ...certificate(LANE, 5_001, 10_000), screeningPolicyDigest: LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST,
    }));
    const result = await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, { descriptors: [descriptor()], observedAtSec: NOW });
    expect(result.status).toBe("ok");
    expect(mocks.screen.mock.calls[0]![0]).toMatchObject({ fromBlock: 5_001, toBlock: 10_000 });
    expect(await certificateRows(db)).toBe(2);
  });

  it("records a deadline deferral when the finalized-head read consumes the remaining window", async () => {
    const { db } = fixtures.open();
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
    const deadlineMs = Date.now() + 10_000;
    mocks.head.mockImplementation(async () => {
      vi.setSystemTime(deadlineMs);
      return null;
    });
    const result = await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: [descriptor()], observedAtSec: NOW, deadlineMs,
    });
    expect(JSON.parse(result.metadata!)).toMatchObject({
      deadlineExhausted: true, failed: 0, deferred: { deadline: 1 },
    });
    expect(await readAttempt(db)).toMatchObject({ outcome: "deferred", reason: "deadline", consecutiveFailures: 0 });
    expect(mocks.screen).not.toHaveBeenCalled();
    expect(await certificateRows(db)).toBe(0);
  });

  it("defers an unfinished slow lane before its deadline without certifying its unscreened tail", async () => {
    const { db } = fixtures.open();
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
    const deadlineMs = Date.now() + 3_500;
    const actual = await vi.importActual<typeof LaneAdminEventModule>(
      "../../lib/safety-score-v9/bridge-lane-admin-events",
    );
    mocks.screen.mockImplementation(actual.screenLaneAdminEvents);
    const head = { ...HEADER, number: 50_000 };
    mocks.head.mockResolvedValue(head);
    vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockResolvedValue(head);
    vi.spyOn(evmRpc, "usableCcipRpcEndpoints").mockReturnValue([{
      url: "https://rpc.example", operator: "public", maxLogBlockSpan: 10_000,
      keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full",
    }]);
    const rpc = vi.spyOn(evmRpc, "fetchEvmRpcBatchDetailed").mockImplementation(async (_chain, calls) => {
      vi.setSystemTime(Date.now() + 900);
      return {
        results: calls.map(call => call.method === "eth_getCode" ? "0x6000"
          : call.method === "eth_getLogs" ? []
          : { number: call.params[0], timestamp: `0x${(NOW - 60).toString(16)}`, hash: HEADER.hash }),
        errors: [],
      };
    });
    const lane = descriptor(LANE, 50_000);
    lane.emitters = [{ ...EMITTER, expectedRuntimeCodeSha256: sha256HexFromBytes(new Uint8Array([0x60, 0])) }];
    const result = await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: [lane], observedAtSec: NOW, deadlineMs, timeoutMs: 1_000,
    });
    expect(Date.now()).toBeLessThan(deadlineMs);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      deadlineExhausted: true, deferred: { deadline: 1 },
      lanes: [{ outcome: "deferred", reason: "deadline" }],
    });
    expect(await readAttempt(db)).toMatchObject({ outcome: "deferred", reason: "deadline", consecutiveFailures: 0 });
    expect(await certificateRows(db)).toBe(0);
    expect(rpc.mock.calls.filter(([, calls]) => calls[0]?.method === "eth_getLogs")).toHaveLength(2);

    // A deadline deferral must not impose the successful refresh hold or the
    // evidence-failure backoff on the next hosting slot.
    mocks.screen.mockResolvedValue(admitted(certificate(LANE, 1, 50_000)));
    const resumed = await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: [lane], observedAtSec: NOW + 3,
    });
    expect(resumed.itemCount).toBe(1);
    expect(await certificateRows(db)).toBe(1);
    expect(await readAttempt(db)).toMatchObject({ outcome: "admitted", consecutiveFailures: 0 });
  });

  it("stores an admitted certificate and makes a rerun of the same slot a no-op", async () => {
    const { db } = fixtures.open();
    mocks.screen.mockResolvedValue(admitted(certificate(LANE, 9_001, 10_000)));

    const first = await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: [descriptor()],
      observedAtSec: NOW,
    });
    expect(first.status).toBe("ok");
    expect(first.itemCount).toBe(1);
    expect(await certificateRows(db)).toBe(1);
    expect(await readAttempt(db)).toMatchObject({ outcome: "admitted", fromBlock: 9_001, toBlock: 10_000 });
    expect(mocks.screen).toHaveBeenCalledTimes(1);

    const second = await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: [descriptor()],
      observedAtSec: NOW,
    });
    expect(second.status).toBe("skipped_neutral");
    expect(JSON.parse(second.metadata!).reason).toBe("no-due-lanes");
    expect(mocks.screen).toHaveBeenCalledTimes(1);
    expect(await certificateRows(db)).toBe(1);
  });

  it("screens against the admitted finalized head instead of a second finalized read", async () => {
    const { db } = fixtures.open();
    mocks.screen.mockResolvedValue(admitted(certificate(LANE, 9_001, 10_000)));

    await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: [descriptor()],
      observedAtSec: NOW,
    });

    expect(mocks.screen).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 9_001, toBlock: 10_000 }),
      expect.objectContaining({ finalizedHead: HEADER }),
    );
    expect(await readAttempt(db)).toMatchObject({
      outcome: "admitted",
      fromBlock: 9_001,
      toBlock: 10_000,
      consecutiveFailures: 0,
    });
  });

  it("records a failure with its machine reason and never writes a certificate", async () => {
    const { db } = fixtures.open();
    mocks.screen.mockResolvedValue(failed(LANE, "pruned-range"));

    const result = await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: [descriptor()],
      observedAtSec: NOW,
    });
    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      reason: "lane-screening-failures",
      failed: 1,
      admitted: 0,
      lanes: [{ subjectDeploymentKey: LANE, outcome: "failed", reason: "pruned-range", detail: "page-refused" }],
    });
    expect(await certificateRows(db)).toBe(0);
    expect(await readAttempt(db)).toMatchObject({
      outcome: "failed",
      failureReason: "pruned-range",
      consecutiveFailures: 1,
    });

    await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: [descriptor()],
      observedAtSec: NOW + 60,
    });
    expect(mocks.screen).toHaveBeenCalledTimes(1);
  });

  it("caps one invocation at the lane budget and leaves the rest for later triggers", async () => {
    const { db } = fixtures.open();
    const lanes = [1, 2, 3, 4, 5].map(index => `ethereum:${`0x${String(index).repeat(40)}`}`);
    mocks.screen.mockImplementation(async (target: { subjectDeploymentKey: string }) =>
      admitted(certificate(target.subjectDeploymentKey, 9_001, 10_000)));

    const result = await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: lanes.map(lane => descriptor(lane)),
      observedAtSec: NOW,
      maxLanesPerInvocation: 2,
    });
    expect(result.itemCount).toBe(2);
    expect(mocks.screen).toHaveBeenCalledTimes(2);
    expect(await certificateRows(db)).toBe(2);
    expect(JSON.parse(result.metadata!)).toMatchObject({ attempted: 2, admitted: 2, deferredByCap: 3, laneCap: 2 });
  });

  it("skips every non-EVM lane before an RPC or a certificate write", async () => {
    const { db } = fixtures.open();
    const result = await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: [descriptor("tron:0xaa")],
      observedAtSec: NOW,
    });
    expect(result.status).toBe("skipped_neutral");
    expect(JSON.parse(result.metadata!)).toMatchObject({
      reason: "no-due-lanes",
      attempted: 0,
      deferred: { "unsupported-chain": 1 },
    });
    expect(mocks.screen).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
    expect(await certificateRows(db)).toBe(0);
  });

  it("records a finalized-head read failure as a lane failure instead of screening", async () => {
    const { db } = fixtures.open();
    mocks.head.mockResolvedValue(null);

    const result = await syncV9LaneAdminEvents(db, CHAIN_RPCS, undefined, {
      descriptors: [descriptor()],
      observedAtSec: NOW,
    });
    expect(result.status).toBe("degraded");
    expect(mocks.screen).not.toHaveBeenCalled();
    expect(await readAttempt(db)).toMatchObject({
      outcome: "failed",
      failureReason: "rpc-unavailable",
      detail: "finalized-head",
    });
    expect(await certificateRows(db)).toBe(0);
  });
});
