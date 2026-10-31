import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex } from "viem/utils";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import {
  V9_LANE_ADMIN_EVENT_FAMILY_VALUES,
  V9LaneIncidentCertificateSchema,
  type V9LaneAdminEventFamily,
  type V9LaneIncidentScreeningResult,
} from "@shared/types/safety-score-v9-incidents";
import type { ChainRpcConfig } from "../chain-registry";
import * as evmRpc from "../evm-rpc";
import {
  LANE_ADMIN_EVENT_MAX_LOG_PAGES,
  LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST,
  LANE_ADMIN_EVENT_TOPICS,
  screenLaneAdminEvents,
  screenLaneAdminEventsBatch,
  type LaneAdminEventEmitter,
  type LaneAdminEventScreeningTarget,
} from "../safety-score-v9/bridge-lane-admin-events";
import { decodeEvmHexBytes } from "../safety-score-v9/supply-observation-primitives";
import { makeChainRpcConfig, makeChainRpcs, registryRpcEndpoint } from "../../test-helpers/chain-rpc-fixtures.test-support";

const CHAIN = "ethereum";
const SUBJECT = `ethereum:0x${"11".repeat(20)}`;
const OAPP = `0x${"33".repeat(20)}`;
const ENDPOINT = `0x${"44".repeat(20)}`;
const CODE_OAPP = "0x6001";
const CODE_ENDPOINT = "0x6002";
const CLOCK = 1_793_294_244;
const FINALIZED_NUMBER = 1_000;
const FROZEN_POLICY_DIGEST = "1140d33cfdafa7e85b863a7d40686f17409b85f60ec444c8e187d4ee27f127ab";
const word = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const quantity = (value: number): string => `0x${value.toString(16)}`;
const runtimeSha = (code: string): string => sha256HexFromBytes(decodeEvmHexBytes(code)!);
const headerAt = (number: number) => ({ number, hash: word(BigInt(number)), timestamp: CLOCK - 1_000 + number });
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

function laneLog(address: string, family: string, blockNumber: number, logIndex = 0): FixtureLog {
  const topic0 = LANE_ADMIN_EVENT_TOPICS.find((topic) => topic.family === family)!.topic0;
  return {
    address,
    topics: [topic0, word(1n)],
    data: "0x",
    blockNumber: quantity(blockNumber),
    blockHash: headerAt(blockNumber).hash,
    transactionHash: word(BigInt(7_000 + blockNumber)),
    logIndex: quantity(logIndex),
    removed: false,
  };
}

function emitter(address: string, families: V9LaneAdminEventFamily[], code = address === OAPP ? CODE_OAPP : CODE_ENDPOINT): LaneAdminEventEmitter {
  return { address: address as `0x${string}`, expectedRuntimeCodeSha256: runtimeSha(code), families };
}

interface HarnessOptions {
  logs?: FixtureLog[];
  codes?: Record<string, string>;
  finalizedNumber?: number;
  logsOverride?: (range: { fromBlock: number; toBlock: number }) => evmRpc.EvmRpcBatchDetailedResult | null;
}

function harness(options: HarnessOptions = {}) {
  const finalized = headerAt(options.finalizedNumber ?? FINALIZED_NUMBER);
  const codes = options.codes ?? { [OAPP]: CODE_OAPP, [ENDPOINT]: CODE_ENDPOINT };
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
            : codes[String(call.params[0]).toLowerCase()] ?? "0x"),
          errors: [],
        };
      }
      if (first.method !== "eth_getLogs") throw new Error(`Unexpected RPC method ${first.method}`);
      const filter = first.params[0] as { address: string | string[]; fromBlock: string; toBlock: string };
      const addresses = new Set((Array.isArray(filter.address) ? filter.address : [filter.address]).map((entry) => entry.toLowerCase()));
      const fromBlock = Number.parseInt(filter.fromBlock, 16);
      const toBlock = Number.parseInt(filter.toBlock, 16);
      logCalls.push({ fromBlock, toBlock });
      if (options.logsOverride) return options.logsOverride({ fromBlock, toBlock });
      return {
        results: [(options.logs ?? []).filter((log) => {
          const blockNumber = Number.parseInt(log.blockNumber, 16);
          return addresses.has(log.address.toLowerCase()) && blockNumber >= fromBlock && blockNumber <= toBlock;
        })],
        errors: [],
      };
    } finally {
      inFlight -= 1;
    }
  });
  return { logCalls, maxInFlight: () => maxInFlight };
}

function target(emitters: readonly LaneAdminEventEmitter[], overrides: Partial<LaneAdminEventScreeningTarget> = {}): LaneAdminEventScreeningTarget {
  return { subjectDeploymentKey: SUBJECT, fromBlock: 900, toBlock: FINALIZED_NUMBER, emitters, ...overrides };
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
  it("maps every emitted family to exactly one ABI topic0", () => {
    expect(LANE_ADMIN_EVENT_TOPICS.map((topic) => topic.family).sort()).toEqual([...V9_LANE_ADMIN_EVENT_FAMILY_VALUES].sort());
    expect(new Set(LANE_ADMIN_EVENT_TOPICS.map((topic) => topic.topic0)).size).toBe(LANE_ADMIN_EVENT_TOPICS.length);
    for (const topic of LANE_ADMIN_EVENT_TOPICS) {
      expect(topic.signature.startsWith(`${topic.family}(`), topic.family).toBe(true);
      expect(topic.topic0, topic.family).toBe(keccak256(toHex(topic.signature)));
    }
  });

  it("publishes one frozen screening-policy digest", () => {
    expect(LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST).toBe(FROZEN_POLICY_DIGEST);
  });
});

describe("pinned multi-emitter lane screening", () => {
  it("emits a clean certificate for the screened emitters and dense counts", async () => {
    harness();
    const oapp = emitter(OAPP, ["Paused", "PeerSet"]);

    const certificate = admitted(await screenLaneAdminEvents(target([oapp]), options()));

    expect(certificate.finding).toBe("no-material-admin-event");
    expect(certificate.evidenceClass).toBe("explorer-events");
    expect(certificate.subjectDeploymentKey).toBe(SUBJECT);
    expect(certificate.fromBlock).toBe(900);
    expect(certificate.toBlock).toBe(FINALIZED_NUMBER);
    expect(certificate.toBlockHash).toBe(headerAt(FINALIZED_NUMBER).hash);
    expect(certificate.windowStartSec).toBe(headerAt(900).timestamp);
    expect(certificate.windowEndSec).toBe(headerAt(FINALIZED_NUMBER).timestamp);
    expect(certificate.observedAtSec).toBe(CLOCK + 60);
    expect(certificate.screeningPolicyDigest).toBe(FROZEN_POLICY_DIGEST);
    expect(certificate.logDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(certificate.certificateId).toBe(`lane-cert:${CHAIN}:${OAPP}:900-${FINALIZED_NUMBER}:${certificate.logDigest.slice(0, 12)}`);
    expect(certificate.emitters).toEqual([{
      address: OAPP,
      expectedRuntimeCodeSha256: runtimeSha(CODE_OAPP),
      runtimeCodeSha256: runtimeSha(CODE_OAPP),
      families: ["Paused", "PeerSet"],
    }]);
    expect(certificate.screenedTopics.map((topic) => topic.family)).toEqual(["Paused", "PeerSet"]);
    expect(certificate.eventCounts).toEqual({ Paused: 0, PeerSet: 0 });
    expect(certificate.materialEvents).toBeUndefined();
    expect(V9LaneIncidentCertificateSchema.safeParse(certificate).success).toBe(true);
  });

  it("attributes a material event to its exact emitter across a multi-emitter lane", async () => {
    const log = laneLog(ENDPOINT, "DelegateSet", 950, 3);
    harness({ logs: [log] });
    const emitters = [emitter(OAPP, ["Paused"]), emitter(ENDPOINT, ["DelegateSet", "SendLibrarySet"])];

    const first = admitted(await screenLaneAdminEvents(target(emitters), options()));
    const second = admitted(await screenLaneAdminEvents(target(emitters), options()));

    expect(first.finding).toBe("material-event");
    expect(first.eventCounts).toEqual({ DelegateSet: 1, Paused: 0, SendLibrarySet: 0 });
    expect(first.screenedTopics.map((topic) => topic.family)).toEqual(["DelegateSet", "Paused", "SendLibrarySet"]);
    expect(first.emitters).toHaveLength(2);
    expect(first.materialEvents).toEqual([{
      address: ENDPOINT,
      family: "DelegateSet",
      transactionHash: log.transactionHash,
      blockNumber: 950,
      logIndex: 3,
    }]);
    expect(second.logDigest).toBe(first.logDigest);
    expect(second.certificateId).toBe(first.certificateId);
  });

  it("fails closed when any emitter's runtime code differs from its reviewed hash", async () => {
    const { logCalls } = harness({ codes: { [OAPP]: CODE_OAPP, [ENDPOINT]: "0x6009" } });

    const result = await screenLaneAdminEvents(target([emitter(OAPP, ["Paused"]), emitter(ENDPOINT, ["DelegateSet"])]), options());

    expect(result).toMatchObject({ outcome: "failed", failureReason: "code-hash-mismatch" });
    expect(result).not.toHaveProperty("certificate");
    expect(logCalls).toHaveLength(0);
  });

  it("fails closed when an emitter has no runtime code", async () => {
    harness({ codes: { [OAPP]: "0x", [ENDPOINT]: CODE_ENDPOINT } });

    expect(await screenLaneAdminEvents(target([emitter(OAPP, ["Paused"]), emitter(ENDPOINT, ["DelegateSet"])]), options()))
      .toMatchObject({ outcome: "failed", failureReason: "missing-controller" });
  });

  it("fails closed when a later log page cannot be read", async () => {
    const chainRpcs = new Map([[CHAIN, {
      ...makeChainRpcConfig({ chainId: CHAIN, rpcUrls: [`https://${CHAIN}.example`] }),
      endpoints: [{ ...registryRpcEndpoint(`https://${CHAIN}.example`), maxLogBlockSpan: 10 }],
    }]]);
    const { logCalls } = harness({
      logsOverride: ({ fromBlock }) => (fromBlock <= 909 ? { results: [[]], errors: [] } : null),
    });

    const result = await screenLaneAdminEvents(target([emitter(OAPP, ["Paused"])], { fromBlock: 900, toBlock: 919 }), options(chainRpcs));

    expect(result).toMatchObject({ outcome: "failed", failureReason: "rpc-unavailable" });
    expect(result).not.toHaveProperty("certificate");
    expect(logCalls).toEqual([{ fromBlock: 900, toBlock: 909 }, { fromBlock: 910, toBlock: 919 }]);
  });

  it("certifies the readable prefix instead of failing when the window needs more pages", async () => {
    const chainRpcs = new Map([[CHAIN, {
      ...makeChainRpcConfig({ chainId: CHAIN, rpcUrls: [`https://${CHAIN}.example`] }),
      endpoints: [{ ...registryRpcEndpoint(`https://${CHAIN}.example`), maxLogBlockSpan: 1 }],
    }]]);
    const { logCalls } = harness();

    const result = await screenLaneAdminEvents(
      target([emitter(OAPP, ["Paused"])], { fromBlock: 900, toBlock: 900 + LANE_ADMIN_EVENT_MAX_LOG_PAGES }),
      options(chainRpcs),
    );

    // A 32-page budget reads 900..931; the certificate covers that prefix so
    // the driver can chain the next window at 932 instead of retrying an
    // unreadable planned range forever.
    const certificate = admitted(result);
    expect(certificate.fromBlock).toBe(900);
    expect(certificate.toBlock).toBe(900 + LANE_ADMIN_EVENT_MAX_LOG_PAGES - 1);
    expect(logCalls).toHaveLength(LANE_ADMIN_EVENT_MAX_LOG_PAGES);
    expect(logCalls[0]).toEqual({ fromBlock: 900, toBlock: 900 });
  });

  it("uses the producer's admitted finalized head instead of a second finalized read", async () => {
    harness({ finalizedNumber: FINALIZED_NUMBER });
    const lagging = { ...headerAt(FINALIZED_NUMBER - 3) };
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockResolvedValue(lagging);

    const certificate = admitted(await screenLaneAdminEvents(
      target([emitter(OAPP, ["Paused"])], { fromBlock: FINALIZED_NUMBER, toBlock: FINALIZED_NUMBER }),
      { ...options(), finalizedHead: headerAt(FINALIZED_NUMBER) },
    ));

    expect(certificate.fromBlock).toBe(FINALIZED_NUMBER);
    expect(certificate.toBlock).toBe(FINALIZED_NUMBER);
  });

  it("fails closed when the provider refuses the log range beyond the split budget", async () => {
    harness({
      logsOverride: () => ({ results: [undefined], errors: [{ index: 0, code: -32005, message: "block range is too wide" }] }),
    });

    const result = await screenLaneAdminEvents(target([emitter(OAPP, ["Paused"])], { fromBlock: 900, toBlock: 901 }), options());

    expect(result).toMatchObject({ outcome: "failed", failureReason: "pruned-range" });
    expect(result).not.toHaveProperty("certificate");
  });

  it("fails closed on a log emitted for a family its emitter did not declare", async () => {
    harness({ logs: [laneLog(OAPP, "DelegateSet", 950)] });

    const result = await screenLaneAdminEvents(
      target([emitter(OAPP, ["Paused"]), emitter(ENDPOINT, ["DelegateSet"])]),
      options(),
    );

    expect(result).toMatchObject({ outcome: "failed", failureReason: "malformed-read" });
    expect(result).not.toHaveProperty("certificate");
  });

  it("fails closed when the pinned range end is not finalized or is ahead of the producer clock", async () => {
    const { logCalls } = harness();
    expect(await screenLaneAdminEvents(target([emitter(OAPP, ["Paused"])], { toBlock: FINALIZED_NUMBER + 1 }), options()))
      .toMatchObject({ outcome: "failed", failureReason: "non-finalized-head" });
    expect(logCalls).toHaveLength(0);
    expect(await screenLaneAdminEvents(target([emitter(OAPP, ["Paused"])]), options(makeChainRpcs([CHAIN]), CLOCK - 1)))
      .toMatchObject({ outcome: "failed", failureReason: "non-finalized-head", detail: "window-end-in-future" });
  });

  it("refuses chains without an EVM endpoint", async () => {
    harness();
    const tron = new Map([[CHAIN, { ...makeChainRpcConfig({ chainId: CHAIN, rpcUrls: [`https://${CHAIN}.example`] }), type: "tron" as const }]]);

    expect(await screenLaneAdminEvents(target([emitter(OAPP, ["Paused"])]), options(tron)))
      .toMatchObject({ outcome: "failed", failureReason: "unsupported-chain" });
    expect(await screenLaneAdminEvents(target([emitter(OAPP, ["Paused"])]), options(new Map())))
      .toMatchObject({ outcome: "failed", failureReason: "unsupported-chain" });
  });

  it("screens a batch of lanes sequentially in input order", async () => {
    const { maxInFlight } = harness();
    const secondSubject = `ethereum:0x${"22".repeat(20)}`;

    const results = await screenLaneAdminEventsBatch([
      target([emitter(OAPP, ["Paused"])]),
      target([emitter(OAPP, ["PeerSet"])], { subjectDeploymentKey: secondSubject }),
    ], options());

    expect(results.map((result) => result.outcome)).toEqual(["admitted", "admitted"]);
    expect(results.map((result) => admitted(result).subjectDeploymentKey)).toEqual([SUBJECT, secondSubject]);
    expect(maxInFlight()).toBe(1);
  });
});
