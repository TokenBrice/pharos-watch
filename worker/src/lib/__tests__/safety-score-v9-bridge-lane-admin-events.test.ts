import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex } from "viem/utils";
import {
  V9_LANE_ADMIN_EVENT_FAMILY_VALUES,
  V9LaneIncidentCertificateSchema,
  type V9LaneIncidentScreeningResult,
} from "@shared/types/safety-score-v9-incidents";
import type { ChainRpcConfig } from "../chain-registry";
import * as evmRpc from "../evm-rpc";
import {
  LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST,
  LANE_ADMIN_EVENT_TOPICS,
  screenLaneAdminEvents,
  screenLaneAdminEventsBatch,
  type LaneAdminEventScreeningTarget,
} from "../safety-score-v9/bridge-lane-admin-events";
import { makeChainRpcConfig, makeChainRpcs, registryRpcEndpoint } from "../../test-helpers/chain-rpc-fixtures.test-support";

const CHAIN = "ethereum";
const ADDRESS = `0x${"11".repeat(20)}`;
const OTHER_ADDRESS = `0x${"22".repeat(20)}`;
const DEPLOYMENT_KEY = `${CHAIN}:${ADDRESS}`;
const CODE = "0x60016000";
const CODE_HASH = keccak256(CODE);
const CLOCK = 1_793_294_244;
const FINALIZED_NUMBER = 1_000;
const FROZEN_POLICY_DIGEST = "6716cf1a5bebd19f1496305ada9f2479d123999895494b13608c82a7d9e716ff";
const word = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const quantity = (value: number): string => `0x${value.toString(16)}`;
const headerAt = (number: number) => ({
  number,
  hash: word(BigInt(number)),
  timestamp: CLOCK - 1_000 + number,
});
const rawHeaderAt = (number: number) => ({
  number: quantity(number),
  hash: word(BigInt(number)),
  timestamp: quantity(headerAt(number).timestamp),
});

type FixtureLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed: boolean;
};

function laneLog(family: string, blockNumber: number, logIndex = 0): FixtureLog {
  const topic0 = LANE_ADMIN_EVENT_TOPICS.find((topic) => topic.family === family)!.topic0;
  return {
    address: ADDRESS,
    topics: [topic0, word(1n)],
    data: "0x",
    blockNumber: quantity(blockNumber),
    blockHash: headerAt(blockNumber).hash,
    transactionHash: word(BigInt(7_000 + blockNumber)),
    logIndex: quantity(logIndex),
    removed: false,
  };
}

interface HarnessOptions {
  logs?: FixtureLog[];
  code?: string;
  finalizedNumber?: number;
  logsOverride?: (range: { fromBlock: number; toBlock: number }) => evmRpc.EvmRpcBatchDetailedResult | null;
}

function harness(options: HarnessOptions = {}) {
  const finalized = headerAt(options.finalizedNumber ?? FINALIZED_NUMBER);
  const logCalls: Array<{ fromBlock: number; toBlock: number }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockImplementation(async (_chainId, blockNumberOrTag) => (
    blockNumberOrTag === "finalized" ? finalized : null
  ));
  vi.spyOn(evmRpc, "fetchEvmRpcBatchDetailed").mockImplementation(async (_chainId, calls) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const first = calls[0]!;
      if (first.method === "eth_getBlockByNumber") {
        return {
          results: calls.map((call) => call.method === "eth_getBlockByNumber"
            ? rawHeaderAt(Number.parseInt(String(call.params[0]), 16))
            : options.code ?? CODE),
          errors: [],
        };
      }
      if (first.method !== "eth_getLogs") throw new Error(`Unexpected RPC method ${first.method}`);
      const filter = first.params[0] as { fromBlock: string; toBlock: string };
      const fromBlock = Number.parseInt(filter.fromBlock, 16);
      const toBlock = Number.parseInt(filter.toBlock, 16);
      logCalls.push({ fromBlock, toBlock });
      if (options.logsOverride) return options.logsOverride({ fromBlock, toBlock });
      return {
        results: [(options.logs ?? []).filter((log) => {
          const blockNumber = Number.parseInt(log.blockNumber, 16);
          return blockNumber >= fromBlock && blockNumber <= toBlock;
        })],
        errors: [],
      };
    } finally {
      inFlight -= 1;
    }
  });
  return { logCalls, maxInFlight: () => maxInFlight };
}

function target(overrides: Partial<LaneAdminEventScreeningTarget> = {}): LaneAdminEventScreeningTarget {
  return { deploymentKey: DEPLOYMENT_KEY, expectedCodeHash: CODE_HASH, fromBlock: 900, toBlock: FINALIZED_NUMBER, ...overrides };
}

function options(chainRpcs: Map<string, ChainRpcConfig> = makeChainRpcs([CHAIN]), observedAtSec = CLOCK + 60) {
  return { chainRpcs, observedAtSec };
}

function admitted(result: V9LaneIncidentScreeningResult) {
  if (result.outcome !== "admitted") throw new Error(`Expected an admitted certificate, got ${JSON.stringify(result)}`);
  return result.certificate;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("frozen lane admin-event topic list", () => {
  it("maps every C3 family to exactly one ABI topic0", () => {
    expect(LANE_ADMIN_EVENT_TOPICS.map((topic) => topic.family).sort()).toEqual([...V9_LANE_ADMIN_EVENT_FAMILY_VALUES].sort());
    expect(new Set(LANE_ADMIN_EVENT_TOPICS.map((topic) => topic.topic0)).size).toBe(LANE_ADMIN_EVENT_TOPICS.length);
    for (const topic of LANE_ADMIN_EVENT_TOPICS) {
      expect(topic.topic0, topic.family).toBe(keccak256(toHex(topic.signature)));
    }
  });

  it("publishes one frozen screening-policy digest", () => {
    expect(LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST).toBe(FROZEN_POLICY_DIGEST);
  });
});

describe("pinned lane admin-event screening", () => {
  it("emits a certificate for a clean range and screens the whole frozen list", async () => {
    harness();

    const certificate = admitted(await screenLaneAdminEvents(target(), options()));

    expect(certificate.finding).toBe("no-material-admin-event");
    expect(certificate.evidenceClass).toBe("explorer-events");
    expect(certificate.codeHash).toBe(CODE_HASH);
    expect(certificate.fromBlock).toBe(900);
    expect(certificate.toBlock).toBe(FINALIZED_NUMBER);
    expect(certificate.windowStartSec).toBe(headerAt(900).timestamp);
    expect(certificate.windowEndSec).toBe(headerAt(FINALIZED_NUMBER).timestamp);
    expect(certificate.observedAtSec).toBe(CLOCK + 60);
    expect(certificate.screeningPolicyDigest).toBe(FROZEN_POLICY_DIGEST);
    expect(certificate.logDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(certificate.certificateId).toBe(`lane-cert:${CHAIN}:${ADDRESS}:900-${FINALIZED_NUMBER}:${certificate.logDigest.slice(0, 12)}`);
    expect(certificate.screenedTopics).toHaveLength(V9_LANE_ADMIN_EVENT_FAMILY_VALUES.length);
    expect(certificate.eventCounts).toEqual(Object.fromEntries(V9_LANE_ADMIN_EVENT_FAMILY_VALUES.map((family) => [family, 0])));
    expect(certificate.materialEvents).toBeUndefined();
    expect(V9LaneIncidentCertificateSchema.safeParse(certificate).success).toBe(true);
  });

  it("reports one admin event as a material finding with its exact reference, deterministically", async () => {
    const log = laneLog("OwnershipTransferred", 950, 3);
    harness({ logs: [log] });

    const first = admitted(await screenLaneAdminEvents(target(), options()));
    const second = admitted(await screenLaneAdminEvents(target(), options()));

    expect(first.finding).toBe("material-event");
    expect(first.eventCounts.OwnershipTransferred).toBe(1);
    expect(first.eventCounts.RoleGranted).toBe(0);
    expect(first.materialEvents).toEqual([{
      family: "OwnershipTransferred",
      transactionHash: log.transactionHash,
      blockNumber: 950,
      logIndex: 3,
    }]);
    expect(second.logDigest).toBe(first.logDigest);
    expect(second.certificateId).toBe(first.certificateId);
    expect(second).toEqual(first);
  });

  it("fails closed when a later log page cannot be read", async () => {
    const chainRpcs = new Map([[CHAIN, {
      ...makeChainRpcConfig({ chainId: CHAIN, rpcUrls: [`https://${CHAIN}.example`] }),
      endpoints: [{ ...registryRpcEndpoint(`https://${CHAIN}.example`), maxLogBlockSpan: 10 }],
    }]]);
    const { logCalls } = harness({
      logsOverride: ({ fromBlock }) => (fromBlock <= 909 ? { results: [[]], errors: [] } : null),
    });

    const result = await screenLaneAdminEvents(target({ fromBlock: 900, toBlock: 919 }), options(chainRpcs));

    expect(result).toMatchObject({ outcome: "failed", failureReason: "rpc-unavailable" });
    expect(result).not.toHaveProperty("certificate");
    expect(logCalls).toEqual([{ fromBlock: 900, toBlock: 909 }, { fromBlock: 910, toBlock: 919 }]);
  });

  it("reads every page of a multi-page window and keeps one request in flight", async () => {
    const chainRpcs = new Map([[CHAIN, {
      ...makeChainRpcConfig({ chainId: CHAIN, rpcUrls: [`https://${CHAIN}.example`] }),
      endpoints: [{ ...registryRpcEndpoint(`https://${CHAIN}.example`), maxLogBlockSpan: 10 }],
    }]]);
    const { logCalls, maxInFlight } = harness({ logs: [laneLog("Paused", 915, 1)] });

    const certificate = admitted(await screenLaneAdminEvents(target({ fromBlock: 900, toBlock: 919 }), options(chainRpcs)));

    expect(logCalls).toEqual([{ fromBlock: 900, toBlock: 909 }, { fromBlock: 910, toBlock: 919 }]);
    expect(maxInFlight()).toBe(1);
    expect(certificate.finding).toBe("material-event");
    expect(certificate.eventCounts.Paused).toBe(1);
    expect(certificate.materialEvents).toHaveLength(1);
  });

  it("fails closed when the provider refuses the log range beyond the split budget", async () => {
    harness({
      logsOverride: () => ({ results: [undefined], errors: [{ index: 0, code: -32005, message: "block range is too wide" }] }),
    });

    const result = await screenLaneAdminEvents(target({ fromBlock: 900, toBlock: 901 }), options());

    expect(result).toMatchObject({ outcome: "failed", failureReason: "pruned-range" });
    expect(result).not.toHaveProperty("certificate");
  });

  it("fails closed on a code-hash mismatch without reading logs", async () => {
    const { logCalls } = harness({ code: "0x6002" });

    const result = await screenLaneAdminEvents(target(), options());

    expect(result).toMatchObject({ outcome: "failed", failureReason: "code-hash-mismatch" });
    expect(result).not.toHaveProperty("certificate");
    expect(logCalls).toHaveLength(0);
  });

  it("fails closed when the lane has no runtime code", async () => {
    harness({ code: "0x" });

    expect(await screenLaneAdminEvents(target(), options())).toMatchObject({ outcome: "failed", failureReason: "missing-controller" });
  });

  it("fails closed when the pinned range end is not finalized", async () => {
    const { logCalls } = harness();

    const result = await screenLaneAdminEvents(target({ toBlock: FINALIZED_NUMBER + 1 }), options());

    expect(result).toMatchObject({ outcome: "failed", failureReason: "non-finalized-head" });
    expect(logCalls).toHaveLength(0);
  });

  it("fails closed when the pinned window end is ahead of the producer clock", async () => {
    harness();

    expect(await screenLaneAdminEvents(target(), options(makeChainRpcs([CHAIN]), CLOCK - 1)))
      .toMatchObject({ outcome: "failed", failureReason: "non-finalized-head", detail: "window-end-in-future" });
  });

  it("refuses non-EVM lanes and chains without an EVM endpoint", async () => {
    harness();
    const tron = new Map([[CHAIN, { ...makeChainRpcConfig({ chainId: CHAIN, rpcUrls: [`https://${CHAIN}.example`] }), type: "tron" as const }]]);

    expect(await screenLaneAdminEvents(target(), options(tron))).toMatchObject({ outcome: "failed", failureReason: "unsupported-chain" });
    expect(await screenLaneAdminEvents(target(), options(new Map()))).toMatchObject({ outcome: "failed", failureReason: "unsupported-chain" });
    expect(await screenLaneAdminEvents(target({ deploymentKey: `${CHAIN}:solana-program` }), options()))
      .toMatchObject({ outcome: "failed", failureReason: "unsupported-chain" });
  });

  it("fails closed on a foreign, removed or out-of-range log entry", async () => {
    for (const log of [
      { ...laneLog("Paused", 950), address: OTHER_ADDRESS },
      { ...laneLog("Paused", 950), removed: true },
      { ...laneLog("Paused", 950), blockNumber: quantity(899) },
      { ...laneLog("Paused", 950), topics: [`0x${"ab".repeat(32)}`] },
    ]) {
      vi.restoreAllMocks();
      harness({ logsOverride: () => ({ results: [log], errors: [] }) });
      const result = await screenLaneAdminEvents(target(), options());
      expect(result.outcome, JSON.stringify(log)).toBe("failed");
      expect(result).not.toHaveProperty("certificate");
    }
  });

  it("screens a batch of lanes sequentially in input order", async () => {
    const { maxInFlight } = harness();
    const second = { ...target(), deploymentKey: `${CHAIN}:${OTHER_ADDRESS}` };

    const results = await screenLaneAdminEventsBatch([target(), second], options());

    expect(results.map((result) => result.outcome)).toEqual(["admitted", "admitted"]);
    expect(results.map((result) => admitted(result).deploymentKey)).toEqual([DEPLOYMENT_KEY, second.deploymentKey]);
    expect(maxInFlight()).toBe(1);
  });
});
