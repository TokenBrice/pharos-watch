import { sha256HexFromBytes } from "@shared/lib/sha256";
import { throwIfAborted } from "./abort";
import type { ChainRpcConfig } from "./chain-registry";
import { fetchTextWithRetry } from "./fetch-retry";
import {
  fetchEvmBlockHeader,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
  type EvmBlockHeader,
} from "./evm-rpc";
import {
  DECIMALS_SELECTOR,
  encodeBalanceOfCallData,
  TOTAL_SUPPLY_SELECTOR,
} from "./evm-selectors";
import { tryParseJson } from "./json-parse";
import {
  buildXautTransparencySource,
  buildXautRepresentationGroupInventory,
  deriveXautRepresentationGroupSupplyAttribution,
  XAUT0_ADAPTER_ADDRESS,
  XAUT_CANONICAL_CHAIN_ID,
  XAUT_CANONICAL_ROUTE_ID,
  XAUT_CANONICAL_TOKEN_ADDRESS,
  XAUT_DISCLOSURE_MAX_AGE_SEC,
  XAUT_REPRESENTATION_ID,
  XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
  XAUT_TRANSPARENCY_SOURCE_ID,
  XAUT_TREASURY_ADDRESS,
  xautLockMintIdentityValidationError,
  type XautLockMintObservation,
  type XautRepresentationGroupSupplyAttributionV2,
} from "./safety-score-v9-xaut-supply-attribution-contract";
import {
  decodeEvmAddress,
  decodeEvmAddressHex,
  decodeEvmHexBytes,
  decodeEvmUint256,
  safetyScoreV9EvmObservationOptions,
} from "./safety-score-v9-supply-observation-primitives";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADAPTER_TOKEN_SELECTOR = "0xfc0c546a";
const ADAPTER_ENDPOINT_SELECTOR = "0x5e280f11";
const MAX_SCORING_CLOCK_REWIND_BLOCKS = 128;
const XAUT_TRANSPARENCY_MAX_RESPONSE_BYTES = 1_000_000;

export interface XautTransparencyDisclosure {
  sourceTimestampSec: number;
  totalAuthorizedRaw: string;
  notIssuedRaw: string;
  quarantinedRaw: string;
}

export type XautSupplyAttributionRejectionCode =
  | "route-inventory-unavailable"
  | "transparency-source-config-unavailable"
  | "transparency-source-unavailable"
  | "transparency-payload-invalid"
  | "transparency-stale"
  | "transparency-clock-skew"
  | "transparency-onchain-mismatch"
  | "transparency-liability-state-invalid"
  | "chain-rpc-unavailable"
  | "finalized-block-unavailable"
  | "observation-stale"
  | "deployment-state-unavailable"
  | "deployment-state-invalid"
  | "deployment-identity-mismatch"
  | "packet-reconciliation-failed";

export type XautSupplyAttributionObservationAttempt =
  | {
      status: "accepted";
      attribution: XautRepresentationGroupSupplyAttributionV2;
    }
  | {
      status: "rejected";
      rejectionCode: XautSupplyAttributionRejectionCode;
      rejectedSourceObservedAtSec: number | null;
      failedRouteId: string | null;
    };

interface XautObserverDependencies {
  sha256HexFromBytes: typeof sha256HexFromBytes;
  fetchEvmBlockHeader: typeof fetchEvmBlockHeader;
  fetchEvmCodeAtBlock: typeof fetchEvmCodeAtBlock;
  fetchEvmMulticall3Aggregate3AtBlock:
    typeof fetchEvmMulticall3Aggregate3AtBlock;
  fetchEvmStorageAtBlock: typeof fetchEvmStorageAtBlock;
  fetchTetherTransparencyText: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<string | null>;
}

async function fetchTetherTransparencyText(
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await fetchTextWithRetry(
    url,
    signal ? { signal } : undefined,
    1,
    {
      logUrl: "Tether transparency",
      timeoutMs: 10_000,
      maxResponseBytes: XAUT_TRANSPARENCY_MAX_RESPONSE_BYTES,
    },
  );
  return result?.response.ok ? result.body : null;
}

const DEFAULT_DEPENDENCIES: XautObserverDependencies = {
  sha256HexFromBytes,
  fetchEvmBlockHeader,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
  fetchTetherTransparencyText,
};

function rpcOptions(
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
) {
  return safetyScoreV9EvmObservationOptions({
    chainRpcs,
    signal,
  });
}

function parseTimestampSec(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseSixDecimalRaw(value: unknown): bigint | null {
  let decimal: string;
  if (typeof value === "string") {
    decimal = value.trim();
  } else if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  ) {
    decimal = value.toString();
  } else {
    return null;
  }
  const decimalPoint = decimal.indexOf(".");
  if (
    decimalPoint !== -1 &&
    decimal.indexOf(".", decimalPoint + 1) !== -1
  ) {
    return null;
  }
  const wholeText =
    decimalPoint === -1 ? decimal : decimal.slice(0, decimalPoint);
  const fractionText =
    decimalPoint === -1 ? "" : decimal.slice(decimalPoint + 1);
  if (
    !/^[0-9]+$/.test(wholeText) ||
    (decimalPoint !== -1 && !/^[0-9]{1,6}$/.test(fractionText))
  ) {
    return null;
  }
  const whole = BigInt(wholeText);
  const fraction = BigInt(fractionText.padEnd(6, "0"));
  return whole * 1_000_000n + fraction;
}

export function parseXautTransparencyDisclosure(
  payload: unknown,
): XautTransparencyDisclosure | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data_formatted" in payload) ||
    !Array.isArray(payload.data_formatted)
  ) {
    return null;
  }
  const xautRows = payload.data_formatted.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as Record<string, unknown>).iso === "string" &&
      ((row as Record<string, unknown>).iso as string).trim().toLowerCase() ===
        "xaut",
  );
  if (xautRows.length !== 1) return null;
  const xautRow = xautRows[0]!;
  const sourceTimestampSec = parseTimestampSec(xautRow.id);
  if (!Array.isArray(xautRow.blockChains) || sourceTimestampSec === null) {
    return null;
  }
  const ethereumRows = xautRow.blockChains.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as Record<string, unknown>).name === "string" &&
      ((row as Record<string, unknown>).name as string)
        .trim()
        .toLowerCase() === "ethereum",
  );
  if (ethereumRows.length !== 1) return null;
  const ethereum = ethereumRows[0]!;
  const totalAuthorizedRaw = parseSixDecimalRaw(
    ethereum.totalAuthorized,
  );
  const notIssuedRaw = parseSixDecimalRaw(ethereum.notIssued);
  const quarantinedRaw = parseSixDecimalRaw(ethereum.quarantined);
  if (
    totalAuthorizedRaw === null ||
    totalAuthorizedRaw <= 0n ||
    notIssuedRaw === null ||
    notIssuedRaw >= totalAuthorizedRaw ||
    quarantinedRaw === null
  ) {
    return null;
  }
  return {
    sourceTimestampSec,
    totalAuthorizedRaw: totalAuthorizedRaw.toString(),
    notIssuedRaw: notIssuedRaw.toString(),
    quarantinedRaw: quarantinedRaw.toString(),
  };
}

function reject(
  rejectionCode: XautSupplyAttributionRejectionCode,
  failedRouteId: string | null,
  rejectedSourceObservedAtSec: number | null = null,
): XautSupplyAttributionObservationAttempt {
  return {
    status: "rejected",
    rejectionCode,
    rejectedSourceObservedAtSec,
    failedRouteId,
  };
}

async function finalizedHeaderAtScoringClock(
  scoringClockSec: number,
  chainRpcs: Map<string, ChainRpcConfig>,
  dependencies: XautObserverDependencies,
  signal?: AbortSignal,
): Promise<EvmBlockHeader | null> {
  const options = rpcOptions(chainRpcs, signal);
  let header = await dependencies.fetchEvmBlockHeader(
    XAUT_CANONICAL_CHAIN_ID,
    "finalized",
    options,
  );
  if (!header) return null;
  for (
    let rewind = 0;
    header.timestamp > scoringClockSec &&
    rewind < MAX_SCORING_CLOCK_REWIND_BLOCKS &&
    header.number > 0;
    rewind += 1
  ) {
    throwIfAborted(signal);
    header = await dependencies.fetchEvmBlockHeader(
      XAUT_CANONICAL_CHAIN_ID,
      header.number - 1,
      options,
    );
    if (!header) return null;
  }
  return header.timestamp <= scoringClockSec ? header : null;
}

export async function observeXautRepresentationGroupSupplyAttributionAttempt(
  input: {
    aggregateSupplyUsd: number;
    registryFingerprint: string;
    scoringClockSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
  },
  dependencyOverrides: Partial<XautObserverDependencies> = {},
): Promise<XautSupplyAttributionObservationAttempt> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const inventory = buildXautRepresentationGroupInventory();
  if (
    !inventory ||
    inventory.representationId !== XAUT_REPRESENTATION_ID
  ) {
    return reject("route-inventory-unavailable", null);
  }
  const transparencySource = buildXautTransparencySource();
  if (!transparencySource) {
    return reject("transparency-source-config-unavailable", null);
  }
  if (!input.chainRpcs.has(XAUT_CANONICAL_CHAIN_ID)) {
    return reject("chain-rpc-unavailable", null);
  }

  throwIfAborted(input.signal);
  let transparencyText: string | null;
  try {
    transparencyText =
      await dependencies.fetchTetherTransparencyText(
        transparencySource.url,
        input.signal,
      );
  } catch {
    throwIfAborted(input.signal);
    return reject("transparency-source-unavailable", null);
  }
  if (transparencyText === null) {
    return reject("transparency-source-unavailable", null);
  }
  const transparencyPayload = tryParseJson(transparencyText, {
    onFailure: () => undefined,
  });
  if (transparencyPayload === null) {
    return reject("transparency-payload-invalid", null);
  }
  const disclosure = parseXautTransparencyDisclosure(
    transparencyPayload,
  );
  if (!disclosure) {
    return reject("transparency-payload-invalid", null);
  }
  if (disclosure.sourceTimestampSec > input.scoringClockSec) {
    return reject(
      "transparency-clock-skew",
      null,
      disclosure.sourceTimestampSec,
    );
  }
  if (
    input.scoringClockSec - disclosure.sourceTimestampSec >
    XAUT_DISCLOSURE_MAX_AGE_SEC
  ) {
    return reject(
      "transparency-stale",
      null,
      disclosure.sourceTimestampSec,
    );
  }
  if (BigInt(disclosure.quarantinedRaw) !== 0n) {
    return reject("transparency-liability-state-invalid", null);
  }
  throwIfAborted(input.signal);
  const blockHeader = await finalizedHeaderAtScoringClock(
    input.scoringClockSec,
    input.chainRpcs,
    dependencies,
    input.signal,
  );
  if (!blockHeader) return reject("finalized-block-unavailable", null);
  if (
    input.scoringClockSec - blockHeader.timestamp >
    XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC
  ) {
    return reject("observation-stale", null, blockHeader.timestamp);
  }

  const options = rpcOptions(input.chainRpcs, input.signal);
  const calls = [
    {
      label: "canonical-total-supply",
      target: XAUT_CANONICAL_TOKEN_ADDRESS,
      callData: TOTAL_SUPPLY_SELECTOR,
      allowFailure: false,
    },
    {
      label: "canonical-decimals",
      target: XAUT_CANONICAL_TOKEN_ADDRESS,
      callData: DECIMALS_SELECTOR,
      allowFailure: false,
    },
    {
      label: "treasury-not-issued-balance",
      target: XAUT_CANONICAL_TOKEN_ADDRESS,
      callData: encodeBalanceOfCallData(XAUT_TREASURY_ADDRESS),
      allowFailure: false,
    },
    {
      label: "adapter-locked-supply",
      target: XAUT_CANONICAL_TOKEN_ADDRESS,
      callData: encodeBalanceOfCallData(XAUT0_ADAPTER_ADDRESS),
      allowFailure: false,
    },
    {
      label: "adapter-token",
      target: XAUT0_ADAPTER_ADDRESS,
      callData: ADAPTER_TOKEN_SELECTOR,
      allowFailure: false,
    },
    {
      label: "adapter-endpoint",
      target: XAUT0_ADAPTER_ADDRESS,
      callData: ADAPTER_ENDPOINT_SELECTOR,
      allowFailure: false,
    },
  ];
  const [results, canonicalRuntimeCode, canonicalImplementationSlot] =
    await Promise.all([
      dependencies.fetchEvmMulticall3Aggregate3AtBlock(
        XAUT_CANONICAL_CHAIN_ID,
        calls,
        blockHeader.number,
        options,
      ),
      dependencies.fetchEvmCodeAtBlock(
        XAUT_CANONICAL_CHAIN_ID,
        XAUT_CANONICAL_TOKEN_ADDRESS,
        blockHeader.number,
        options,
      ),
      dependencies.fetchEvmStorageAtBlock(
        XAUT_CANONICAL_CHAIN_ID,
        XAUT_CANONICAL_TOKEN_ADDRESS,
        EIP1967_IMPLEMENTATION_SLOT,
        blockHeader.number,
        options,
      ),
    ]);
  const [adapterRuntimeCode, adapterImplementationSlot] = await Promise.all([
    dependencies.fetchEvmCodeAtBlock(
      XAUT_CANONICAL_CHAIN_ID,
      XAUT0_ADAPTER_ADDRESS,
      blockHeader.number,
      options,
    ),
    dependencies.fetchEvmStorageAtBlock(
      XAUT_CANONICAL_CHAIN_ID,
      XAUT0_ADAPTER_ADDRESS,
      EIP1967_IMPLEMENTATION_SLOT,
      blockHeader.number,
      options,
    ),
  ]);
  if (
    !results ||
    results.length !== calls.length ||
    !canonicalRuntimeCode ||
    !canonicalImplementationSlot ||
    !adapterRuntimeCode ||
    !adapterImplementationSlot
  ) {
    return reject("deployment-state-unavailable", XAUT_CANONICAL_ROUTE_ID);
  }

  const canonicalTotalSupplyRaw = decodeEvmUint256(results[0]);
  const decimalsRaw = decodeEvmUint256(results[1]);
  const treasuryBalanceRaw = decodeEvmUint256(results[2]);
  const adapterLockedSupplyRaw = decodeEvmUint256(results[3]);
  const adapterTokenAddress = decodeEvmAddress(results[4]);
  const adapterEndpointAddress = decodeEvmAddress(results[5]);
  const canonicalImplementationAddress = decodeEvmAddressHex(
    canonicalImplementationSlot,
  );
  const adapterImplementationAddress = decodeEvmAddressHex(
    adapterImplementationSlot,
  );
  const canonicalRuntimeBytes = decodeEvmHexBytes(canonicalRuntimeCode);
  const adapterRuntimeBytes = decodeEvmHexBytes(adapterRuntimeCode);
  if (
    canonicalTotalSupplyRaw === null ||
    decimalsRaw === null ||
    decimalsRaw > 36n ||
    treasuryBalanceRaw === null ||
    adapterLockedSupplyRaw === null ||
    adapterTokenAddress === null ||
    adapterEndpointAddress === null ||
    canonicalImplementationAddress === null ||
    adapterImplementationAddress === null ||
    canonicalRuntimeBytes === null ||
    adapterRuntimeBytes === null
  ) {
    return reject("deployment-state-invalid", XAUT_CANONICAL_ROUTE_ID);
  }

  const [canonicalImplementationCode, adapterImplementationCode] =
    await Promise.all([
      dependencies.fetchEvmCodeAtBlock(
        XAUT_CANONICAL_CHAIN_ID,
        canonicalImplementationAddress,
        blockHeader.number,
        options,
      ),
      dependencies.fetchEvmCodeAtBlock(
        XAUT_CANONICAL_CHAIN_ID,
        adapterImplementationAddress,
        blockHeader.number,
        options,
      ),
    ]);
  const canonicalImplementationBytes = canonicalImplementationCode
    ? decodeEvmHexBytes(canonicalImplementationCode)
    : null;
  const adapterImplementationBytes = adapterImplementationCode
    ? decodeEvmHexBytes(adapterImplementationCode)
    : null;
  if (!canonicalImplementationBytes || !adapterImplementationBytes) {
    return reject("deployment-state-unavailable", XAUT_CANONICAL_ROUTE_ID);
  }
  const confirmedHeader = await dependencies.fetchEvmBlockHeader(
    XAUT_CANONICAL_CHAIN_ID,
    blockHeader.number,
    options,
  );
  if (
    !confirmedHeader ||
    confirmedHeader.hash !== blockHeader.hash ||
    confirmedHeader.timestamp !== blockHeader.timestamp
  ) {
    return reject("finalized-block-unavailable", null);
  }
  if (
    canonicalTotalSupplyRaw.toString() !== disclosure.totalAuthorizedRaw ||
    treasuryBalanceRaw.toString() !== disclosure.notIssuedRaw
  ) {
    return reject(
      "transparency-onchain-mismatch",
      XAUT_CANONICAL_ROUTE_ID,
    );
  }

  const observation: XautLockMintObservation = {
    chainId: XAUT_CANONICAL_CHAIN_ID,
    canonicalTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
    adapterAddress: XAUT0_ADAPTER_ADDRESS,
    decimals: Number(decimalsRaw),
    canonicalTotalSupplyRaw: canonicalTotalSupplyRaw.toString(),
    treasuryAddress: XAUT_TREASURY_ADDRESS,
    treasuryBalanceRaw: treasuryBalanceRaw.toString(),
    adapterLockedSupplyRaw: adapterLockedSupplyRaw.toString(),
    blockNumber: blockHeader.number,
    blockTimeSec: blockHeader.timestamp,
    blockHash: blockHeader.hash,
    canonicalRuntimeCodeSha256:
      dependencies.sha256HexFromBytes(canonicalRuntimeBytes),
    canonicalImplementationAddress,
    canonicalImplementationCodeSha256:
      dependencies.sha256HexFromBytes(canonicalImplementationBytes),
    adapterRuntimeCodeSha256:
      dependencies.sha256HexFromBytes(adapterRuntimeBytes),
    adapterImplementationAddress,
    adapterImplementationCodeSha256:
      dependencies.sha256HexFromBytes(adapterImplementationBytes),
    adapterTokenAddress,
    adapterEndpointAddress,
    disclosure: {
      sourceId: XAUT_TRANSPARENCY_SOURCE_ID,
      sourceConfigDigest: transparencySource.configDigest,
      sourceTimestampSec: disclosure.sourceTimestampSec,
      responseSha256: dependencies.sha256HexFromBytes(
        new TextEncoder().encode(transparencyText),
      ),
      totalAuthorizedRaw: disclosure.totalAuthorizedRaw,
      notIssuedRaw: disclosure.notIssuedRaw,
      quarantinedRaw: disclosure.quarantinedRaw,
    },
  };
  if (xautLockMintIdentityValidationError(observation)) {
    return reject(
      "deployment-identity-mismatch",
      XAUT_CANONICAL_ROUTE_ID,
    );
  }

  const attribution = deriveXautRepresentationGroupSupplyAttribution({
    aggregateSupplyUsd: input.aggregateSupplyUsd,
    registryFingerprint: input.registryFingerprint,
    scoringClockSec: input.scoringClockSec,
    observation,
  });
  return attribution
    ? { status: "accepted", attribution }
    : reject("packet-reconciliation-failed", null);
}
