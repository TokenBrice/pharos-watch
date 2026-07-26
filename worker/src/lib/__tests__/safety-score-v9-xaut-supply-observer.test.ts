import { describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../chain-registry";
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
  XAUT_TRANSPARENCY_SOURCE_ID,
  XAUT_TREASURY_ADDRESS,
} from "../safety-score-v9-xaut-supply-attribution-contract";
import {
  observeXautRepresentationGroupSupplyAttributionAttempt,
  parseXautTransparencyDisclosure,
} from "../safety-score-v9-xaut-supply-observer";

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

function uint256(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function addressWord(address: string): `0x${string}` {
  return `0x${address.slice(2).padStart(64, "0")}` as `0x${string}`;
}

function chainRpcs(): Map<string, ChainRpcConfig> {
  return new Map([
    [
      "ethereum",
      {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://ethereum.example",
        explorerUrl: "https://etherscan.io",
      },
    ],
  ]);
}

function observerDependencies() {
  const fetchEvmBlockHeader = vi.fn().mockResolvedValue({
    number: BLOCK_NUMBER,
    timestamp: BLOCK_TIME_SEC,
    hash: BLOCK_HASH,
  });
  const fetchEvmMulticall3Aggregate3AtBlock = vi.fn().mockResolvedValue([
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
      returnData: addressWord(XAUT_CANONICAL_TOKEN_ADDRESS),
    },
    {
      label: "adapter-endpoint",
      success: true,
      returnData: addressWord(XAUT0_LAYERZERO_ENDPOINT_ADDRESS),
    },
  ]);
  const fetchEvmCodeAtBlock = vi.fn(
    async (_chainId: string | undefined, address: string) => {
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
    async (_chainId: string | undefined, address: string) =>
      address.toLowerCase() === XAUT_CANONICAL_TOKEN_ADDRESS
        ? addressWord(XAUT_CANONICAL_IMPLEMENTATION_ADDRESS)
        : addressWord(XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS),
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
      expect.objectContaining({ chainRpcs: expect.any(Map) }),
    );
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
          scoringClockSec: BLOCK_TIME_SEC + 1_801,
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
