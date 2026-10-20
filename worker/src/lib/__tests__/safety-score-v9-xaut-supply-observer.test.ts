import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import { mockFetchStrict } from "@shared/test-utils/mock-fetch";
import { uint256, addressWord, chainRpcs } from "./safety-score-v9-supply-observation.test-support";
import { fetchEvmCodeAtBlock, fetchEvmMulticall3Aggregate3AtBlock, fetchEvmStorageAtBlock, MULTICALL3_ADDRESS, type EvmMulticall3Call, type EvmRpcOptions } from "../evm-rpc";
import {
  buildXautTransparencySource,
  XAUT0_ADAPTER_ADDRESS,
  XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS,
  XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256,
  XAUT0_ADAPTER_RUNTIME_CODE_SHA256,
  XAUT0_LAYERZERO_ENDPOINT_ADDRESS,
  XAUT_CANONICAL_IMPLEMENTATION_ADDRESS,
  XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256,
  XAUT_CANONICAL_RUNTIME_CODE_SHA256,
  XAUT_CANONICAL_TOKEN_ADDRESS,
  XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
  XAUT_TRANSPARENCY_SOURCE_ID,
  XAUT_TREASURY_ADDRESS,
} from "../safety-score-v9/xaut-supply-attribution-contract";
import {
  observeXautRepresentationGroupSupplyAttributionAttempt,
  parseXautTransparencyDisclosure,
} from "../safety-score-v9/xaut-supply-observer";

import { expectRecentPinRouting } from "../../test-helpers/recent-pin-routing";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const BLOCK_NUMBER = 25_601_844;
const BLOCK_TIME_SEC = 1_784_887_019;
const BLOCK_HASH = `0x${"ab".repeat(32)}` as const;
const TOTAL_SUPPLY_RAW = 707_747_089_000n;
const TREASURY_BALANCE_RAW = 94_923_429_468n;
const LOCKED_SUPPLY_RAW = 29_720_802_896n;
const AGGREGATE_SUPPLY_USD = 2_480_000_000;

function transparencyBody(input: {
  sourceTimestampSec?: number;
  totalAuthorized?: string | number;
  notIssued?: string | number;
  quarantined?: string | number;
} = {}): string {
  return JSON.stringify({
    data_formatted: [
      {
        id: input.sourceTimestampSec ?? BLOCK_TIME_SEC - 100,
        iso: "xaut",
        blockChains: [
          {
            name: "Ethereum",
            totalAuthorized:
              input.totalAuthorized ?? "707747.089",
            notIssued: input.notIssued ?? "94923.429468",
            quarantined: input.quarantined ?? 0,
          },
        ],
      },
    ],
  });
}


interface OnchainSupplyOverrides {
  totalSupplyRaw?: bigint;
  treasuryBalanceRaw?: bigint;
}

function requireStateHash(options?: EvmRpcOptions): void {
  if (options?.stateBlockHash !== BLOCK_HASH) throw new Error("Unexpected XAUT state hash");
}

function observerDependencies(onchain: OnchainSupplyOverrides = {}) {
  const fetchEvmBlockHeader = vi.fn().mockResolvedValue({
    number: BLOCK_NUMBER,
    timestamp: BLOCK_TIME_SEC,
    hash: BLOCK_HASH,
  });
  const fetchEvmMulticall3Aggregate3AtBlock = vi.fn(async (
    chainId: string | undefined, calls: readonly EvmMulticall3Call[], block?: number | "latest",
    options?: EvmRpcOptions,
  ) => {
    if (chainId !== "ethereum" || block !== BLOCK_NUMBER) throw new Error("Unexpected XAUT block");
    requireStateHash(options);
    const token = "0x68749665ff8d2d112fa859aa293f07a622782f38";
    const adapter = "0xb9c2321bb7d0db468f570d10a424d1cc8efd696c";
    const values: Record<string, `0x${string}`> = {
      [`${token}:0x18160ddd`]: uint256(onchain.totalSupplyRaw ?? TOTAL_SUPPLY_RAW),
      [`${token}:0x313ce567`]: uint256(6n),
      [`${token}:0x70a082310000000000000000000000005754284f345afc66a98fbb0a0afe71e0f007b949`]: uint256(onchain.treasuryBalanceRaw ?? TREASURY_BALANCE_RAW),
      [`${token}:0x70a08231000000000000000000000000b9c2321bb7d0db468f570d10a424d1cc8efd696c`]: uint256(LOCKED_SUPPLY_RAW),
      [`${adapter}:0xfc0c546a`]: addressWord(token),
      [`${adapter}:0x5e280f11`]: addressWord("0x1a44076050125825900e736c501f859c50fe728c"),
    };
    return calls.map((call) => {
      const value = values[`${call.target.toLowerCase()}:${call.callData}`];
      if (!value) throw new Error("Unexpected XAUT request");
      return { label: call.label, success: true, returnData: value };
    });
  });
  const fetchEvmCodeAtBlock = vi.fn(
    async (_chainId: string | undefined, address: string, _block?: number | "latest", options?: EvmRpcOptions) => {
      requireStateHash(options);
      switch (address.toLowerCase()) {
        case XAUT_CANONICAL_TOKEN_ADDRESS:
          return "0x01";
        case XAUT0_ADAPTER_ADDRESS:
          return "0x02";
        case XAUT_CANONICAL_IMPLEMENTATION_ADDRESS:
          return "0x03";
        case XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS:
          return "0x04";
        default:
          return null;
      }
    },
  );
  const fetchEvmStorageAtBlock = vi.fn(
    async (_chainId: string | undefined, address: string, _slot: string, _block?: number | "latest", options?: EvmRpcOptions) => {
      requireStateHash(options);
      return address.toLowerCase() === XAUT_CANONICAL_TOKEN_ADDRESS
        ? addressWord(XAUT_CANONICAL_IMPLEMENTATION_ADDRESS)
        : addressWord(XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS);
    },
  );
  const sha256HexFromBytes = vi.fn((bytes: Uint8Array) => {
    switch (bytes[0]) {
      case 1:
        return XAUT_CANONICAL_RUNTIME_CODE_SHA256;
      case 2:
        return XAUT0_ADAPTER_RUNTIME_CODE_SHA256;
      case 3:
        return XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256;
      case 4:
        return XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256;
      default:
        return "0".repeat(64);
    }
  });
  const fetchTetherTransparencyText = vi
    .fn()
    .mockResolvedValue(transparencyBody());
  return {
    fetchEvmBlockHeader,
    fetchEvmMulticall3Aggregate3AtBlock,
    fetchEvmCodeAtBlock,
    fetchEvmStorageAtBlock,
    sha256HexFromBytes,
    fetchTetherTransparencyText,
  };
}

describe("XAUT representation-group supply observer", () => {
  it("parses the configured XAUT Ethereum disclosure as exact six-decimal raw units", () => {
    expect(
      parseXautTransparencyDisclosure(
        JSON.parse(transparencyBody()),
      ),
    ).toEqual({
      sourceTimestampSec: BLOCK_TIME_SEC - 100,
      totalAuthorizedRaw: TOTAL_SUPPLY_RAW.toString(),
      notIssuedRaw: TREASURY_BALANCE_RAW.toString(),
      quarantinedRaw: "0",
    });
    expect(
      parseXautTransparencyDisclosure(
        JSON.parse(
          transparencyBody({
            totalAuthorized: "707747.0890001",
          }),
        ),
      ),
    ).toBeNull();
    expect(
      buildXautTransparencySource(),
    ).toMatchObject({
      sourceId: XAUT_TRANSPARENCY_SOURCE_ID,
      url: "https://app.tether.to/transparency.json",
    });
  });

  it("binds one finalized block to token, adapter, inventory, and conserved supply", async () => {
    const dependencies = observerDependencies();
    const attempt =
      await observeXautRepresentationGroupSupplyAttributionAttempt(
        {
          aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
          registryFingerprint: "a".repeat(64),
          scoringClockSec: BLOCK_TIME_SEC + 100,
          chainRpcs: chainRpcs(),
        },
        dependencies,
      );

    expect(attempt.status).toBe("accepted");
    if (attempt.status !== "accepted") return;
    expect(attempt.attribution).toMatchObject({
      model: "canonical-lock-mint-group-partition-v2",
      observedAtSec: BLOCK_TIME_SEC,
      observation: {
        blockNumber: BLOCK_NUMBER,
        blockHash: BLOCK_HASH,
        canonicalTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
        treasuryAddress: XAUT_TREASURY_ADDRESS,
        treasuryBalanceRaw: TREASURY_BALANCE_RAW.toString(),
        adapterAddress: XAUT0_ADAPTER_ADDRESS,
        adapterTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
        adapterEndpointAddress: XAUT0_LAYERZERO_ENDPOINT_ADDRESS,
        disclosure: {
          sourceId: XAUT_TRANSPARENCY_SOURCE_ID,
          sourceConfigDigest:
            buildXautTransparencySource()!.configDigest,
          sourceTimestampSec: BLOCK_TIME_SEC - 100,
          responseSha256: "0".repeat(64),
          totalAuthorizedRaw: TOTAL_SUPPLY_RAW.toString(),
          notIssuedRaw: TREASURY_BALANCE_RAW.toString(),
          quarantinedRaw: "0",
        },
      },
      representationGroup: {
        representationId: "xaut0-omnichain",
        riskTier: "external-lock-mint",
      },
    });
    expect(attempt.attribution.representationGroup.routeIds).toHaveLength(14);
    expect(
      attempt.attribution.canonical.currentSupplyUsd +
        attempt.attribution.representationGroup.currentSupplyUsd,
    ).toBe(AGGREGATE_SUPPLY_USD);
    expect(
      attempt.attribution.representationGroup.currentSupplyUsd /
        AGGREGATE_SUPPLY_USD,
    ).toBeCloseTo(0.04849813227, 10);
    expect(
      dependencies.fetchTetherTransparencyText,
    ).toHaveBeenCalledWith(
      "https://app.tether.to/transparency.json",
      undefined,
    );
    expect(
      dependencies.fetchEvmMulticall3Aggregate3AtBlock,
    ).toHaveBeenCalledWith(
      "ethereum",
      expect.any(Array),
      BLOCK_NUMBER,
      expect.objectContaining({ chainRpcs: expect.any(Map), stateBlockHash: BLOCK_HASH }),
    );
    const options = vi.mocked(dependencies.fetchEvmMulticall3Aggregate3AtBlock).mock.calls[0][3]!;
    expect(options.recentStatePin).toEqual({ chainId: "ethereum",
      header: { number: BLOCK_NUMBER, hash: BLOCK_HASH, timestamp: BLOCK_TIME_SEC },
      finalized: { number: BLOCK_NUMBER, hash: BLOCK_HASH, timestamp: BLOCK_TIME_SEC },
      observedAtSec: BLOCK_TIME_SEC + 100, maxAgeSec: XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC });
    expect(dependencies.fetchEvmCodeAtBlock).toHaveBeenCalledTimes(4);
    expect(dependencies.fetchEvmCodeAtBlock.mock.calls.map(([, address]) => address)).toEqual([
      XAUT_CANONICAL_TOKEN_ADDRESS, XAUT0_ADAPTER_ADDRESS,
      XAUT_CANONICAL_IMPLEMENTATION_ADDRESS, XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS,
    ]);
    for (const [, , block, options] of dependencies.fetchEvmCodeAtBlock.mock.calls) {
      expect(block).toBe(BLOCK_NUMBER);
      expect(options).toMatchObject({ stateBlockHash: BLOCK_HASH });
    }
    expect(dependencies.fetchEvmStorageAtBlock).toHaveBeenCalledTimes(2);
    for (const [, , , block, options] of dependencies.fetchEvmStorageAtBlock.mock.calls) {
      expect(block).toBe(BLOCK_NUMBER);
      expect(options).toMatchObject({ stateBlockHash: BLOCK_HASH });
    }
    await expectRecentPinRouting(options);
    expect(dependencies.fetchEvmBlockHeader).toHaveBeenNthCalledWith(
      1,
      "ethereum",
      "finalized",
      expect.any(Object),
    );
    expect(dependencies.fetchEvmBlockHeader).toHaveBeenLastCalledWith(
      "ethereum",
      BLOCK_NUMBER,
      expect.any(Object),
    );
    expect(dependencies.sha256HexFromBytes).toHaveBeenCalledWith(
      new TextEncoder().encode(transparencyBody()),
    );
  });

  it.each([true, false])("keeps state on the admitted fork when EIP-1898 support is %s", async supportsHash => {
    vi.spyOn(Date, "now").mockReturnValue((BLOCK_TIME_SEC + 100) * 1_000);
    const selectors: unknown[] = [];
    const codes: Record<string, `0x${string}`> = {
      [XAUT_CANONICAL_TOKEN_ADDRESS]: "0x01", [XAUT0_ADAPTER_ADDRESS]: "0x02",
      [XAUT_CANONICAL_IMPLEMENTATION_ADDRESS]: "0x03", [XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS]: "0x04",
    };
    const transport = mockFetchStrict([{ match: request => new URL(request.url).href === "https://ethereum.example/", respond: async request => {
      const rpc = await request.json() as { id: number; method: string; params: unknown[] };
      const selector = rpc.params[rpc.method === "eth_getStorageAt" ? 2 : 1];
      selectors.push(selector);
      const pinned = typeof selector === "object" && selector !== null && "blockHash" in selector &&
        selector.blockHash === BLOCK_HASH && "requireCanonical" in selector && selector.requireCanonical === true;
      if (pinned && !supportsHash) return { body: { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "EIP-1898 unsupported" } } };
      let result: `0x${string}`;
      if (rpc.method === "eth_call") {
        const call = rpc.params[0];
        if (!call || typeof call !== "object" || !("to" in call) || call.to !== MULTICALL3_ADDRESS) throw new Error("Unexpected direct XAUT call");
        // Numbered reads see a different fork despite unchanged header rechecks.
        const values = [uint256(1_000_000_000n), uint256(6n), uint256(0n),
          uint256(pinned ? 100_000_000n : 200_000_000n),
          addressWord(XAUT_CANONICAL_TOKEN_ADDRESS), addressWord(XAUT0_LAYERZERO_ENDPOINT_ADDRESS)];
        result = encodeAbiParameters(parseAbiParameters("(bool success,bytes returnData)[]"),
          [values.map(returnData => ({ success: true, returnData }))]);
      } else if (rpc.method === "eth_getCode" && typeof rpc.params[0] === "string" && codes[rpc.params[0]]) {
        result = codes[rpc.params[0]]!;
      } else if (rpc.method === "eth_getStorageAt") {
        result = addressWord(rpc.params[0] === XAUT_CANONICAL_TOKEN_ADDRESS
          ? XAUT_CANONICAL_IMPLEMENTATION_ADDRESS : XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS);
      } else throw new Error(`Unexpected XAUT RPC method ${rpc.method}`);
      return { body: { jsonrpc: "2.0", id: rpc.id, result } };
    } }]);
    const dependencies = observerDependencies();
    dependencies.fetchTetherTransparencyText.mockResolvedValue(transparencyBody({ totalAuthorized: "1000", notIssued: "0" }));
    const result = await observeXautRepresentationGroupSupplyAttributionAttempt({
      aggregateSupplyUsd: 1000, registryFingerprint: "a".repeat(64),
      scoringClockSec: BLOCK_TIME_SEC + 100, chainRpcs: chainRpcs(),
    }, { ...dependencies, fetchEvmCodeAtBlock, fetchEvmStorageAtBlock, fetchEvmMulticall3Aggregate3AtBlock });
    if (supportsHash) {
      expect(result).toMatchObject({ status: "accepted", attribution: { representationGroup: { currentSupplyUsd: 100 } } });
      expect(selectors).toHaveLength(7);
    } else {
      expect(result).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable" });
      expect(result).not.toHaveProperty("attribution");
      expect(selectors.length).toBeGreaterThan(0);
    }
    for (const selector of selectors) expect(selector).toEqual({ blockHash: BLOCK_HASH, requireCanonical: true });
    transport.assertAllRoutesUsed();
  });

  it.each([
    {
      label: "unavailable source",
      body: null,
      scoringClockSec: BLOCK_TIME_SEC + 100,
      rejectionCode: "transparency-source-unavailable",
      rejectedSourceObservedAtSec: null,
    },
    {
      label: "malformed payload",
      body: "{}",
      scoringClockSec: BLOCK_TIME_SEC + 100,
      rejectionCode: "transparency-payload-invalid",
      rejectedSourceObservedAtSec: null,
    },
    {
      label: "future disclosure",
      body: transparencyBody({
        sourceTimestampSec: BLOCK_TIME_SEC + 101,
      }),
      scoringClockSec: BLOCK_TIME_SEC + 100,
      rejectionCode: "transparency-clock-skew",
      rejectedSourceObservedAtSec: BLOCK_TIME_SEC + 101,
    },
    {
      label: "stale disclosure",
      body: transparencyBody({
        sourceTimestampSec: BLOCK_TIME_SEC - 172_801,
      }),
      scoringClockSec: BLOCK_TIME_SEC,
      rejectionCode: "transparency-stale",
      rejectedSourceObservedAtSec: BLOCK_TIME_SEC - 172_801,
    },
    {
      label: "quarantined liabilities",
      body: transparencyBody({ quarantined: "0.000001" }),
      scoringClockSec: BLOCK_TIME_SEC + 100,
      rejectionCode: "transparency-liability-state-invalid",
      rejectedSourceObservedAtSec: null,
    },
    {
      label: "on-chain mismatch",
      body: transparencyBody({ notIssued: "94923.429467" }),
      scoringClockSec: BLOCK_TIME_SEC + 100,
      rejectionCode: "transparency-onchain-mismatch",
      rejectedSourceObservedAtSec: null,
    },
  ])(
    "rejects $label with a disclosure-specific code",
    async ({
      body,
      scoringClockSec,
      rejectionCode,
      rejectedSourceObservedAtSec,
    }) => {
      const dependencies = observerDependencies();
      dependencies.fetchTetherTransparencyText.mockResolvedValueOnce(
        body,
      );
      await expect(
        observeXautRepresentationGroupSupplyAttributionAttempt(
          {
            aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
            registryFingerprint: "a".repeat(64),
            scoringClockSec,
            chainRpcs: chainRpcs(),
          },
          dependencies,
        ),
      ).resolves.toMatchObject({
        status: "rejected",
        rejectionCode,
        rejectedSourceObservedAtSec,
      });
    },
  );

  it("reconciles a treasury-only mint after the daily disclosure on the circulating liability", async () => {
    const observe = (onchain: OnchainSupplyOverrides = {}) =>
      observeXautRepresentationGroupSupplyAttributionAttempt(
        {
          aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
          registryFingerprint: "a".repeat(64),
          scoringClockSec: BLOCK_TIME_SEC + 100,
          chainRpcs: chainRpcs(),
        },
        observerDependencies(onchain),
      );
    // Tether's 2026-09-28 treasury mint after its daily disclosure snapshot.
    const treasuryMintRaw = 119_670_541_000n;
    const baseline = await observe();
    const minted = await observe({
      totalSupplyRaw: TOTAL_SUPPLY_RAW + treasuryMintRaw,
      treasuryBalanceRaw: TREASURY_BALANCE_RAW + treasuryMintRaw,
    });
    if (baseline.status !== "accepted" || minted.status !== "accepted") {
      throw new Error("expected both XAUT observations to be accepted");
    }
    expect(minted.attribution.observation).toMatchObject({
      canonicalTotalSupplyRaw: (TOTAL_SUPPLY_RAW + treasuryMintRaw).toString(),
      treasuryBalanceRaw: (TREASURY_BALANCE_RAW + treasuryMintRaw).toString(),
      disclosure: baseline.attribution.observation.disclosure,
    });
    expect(minted.attribution.canonical).toEqual(baseline.attribution.canonical);
    expect(minted.attribution.representationGroup).toEqual(
      baseline.attribution.representationGroup,
    );

    await expect(
      observe({ totalSupplyRaw: TOTAL_SUPPLY_RAW + treasuryMintRaw }),
    ).resolves.toMatchObject({
      status: "rejected",
      rejectionCode: "transparency-onchain-mismatch",
    });
  });

  it("rejects adapter identity drift", async () => {
    const dependencies = observerDependencies();
    dependencies.fetchEvmMulticall3Aggregate3AtBlock.mockResolvedValueOnce([
      {
        label: "canonical-total-supply",
        success: true,
        returnData: uint256(TOTAL_SUPPLY_RAW),
      },
      {
        label: "canonical-decimals",
        success: true,
        returnData: uint256(6n),
      },
      {
        label: "treasury-not-issued-balance",
        success: true,
        returnData: uint256(TREASURY_BALANCE_RAW),
      },
      {
        label: "adapter-locked-supply",
        success: true,
        returnData: uint256(LOCKED_SUPPLY_RAW),
      },
      {
        label: "adapter-token",
        success: true,
        returnData: addressWord(
          "0x0000000000000000000000000000000000000001",
        ),
      },
      {
        label: "adapter-endpoint",
        success: true,
        returnData: addressWord(XAUT0_LAYERZERO_ENDPOINT_ADDRESS),
      },
    ]);

    await expect(
      observeXautRepresentationGroupSupplyAttributionAttempt(
        {
          aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
          registryFingerprint: "a".repeat(64),
          scoringClockSec: BLOCK_TIME_SEC + 100,
          chainRpcs: chainRpcs(),
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      rejectionCode: "deployment-identity-mismatch",
    });
  });

  it("rejects stale finalized state and a changed confirmation hash", async () => {
    const stale = observerDependencies();
    await expect(
      observeXautRepresentationGroupSupplyAttributionAttempt(
        {
          aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
          registryFingerprint: "a".repeat(64),
          scoringClockSec:
            BLOCK_TIME_SEC + XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC + 1,
          chainRpcs: chainRpcs(),
        },
        stale,
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      rejectionCode: "observation-stale",
      rejectedSourceObservedAtSec: BLOCK_TIME_SEC,
    });
    expect(stale.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();

    const reorg = observerDependencies();
    reorg.fetchEvmBlockHeader
      .mockResolvedValueOnce({
        number: BLOCK_NUMBER,
        timestamp: BLOCK_TIME_SEC,
        hash: BLOCK_HASH,
      })
      .mockResolvedValueOnce({
        number: BLOCK_NUMBER,
        timestamp: BLOCK_TIME_SEC,
        hash: `0x${"cd".repeat(32)}`,
      });
    await expect(
      observeXautRepresentationGroupSupplyAttributionAttempt(
        {
          aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
          registryFingerprint: "a".repeat(64),
          scoringClockSec: BLOCK_TIME_SEC + 100,
          chainRpcs: chainRpcs(),
        },
        reorg,
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      rejectionCode: "finalized-block-unavailable",
    });
  });
});
