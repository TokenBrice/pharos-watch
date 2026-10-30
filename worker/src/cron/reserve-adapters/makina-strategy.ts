import { z } from "zod";
import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { CHAIN_META } from "@shared/types/chain-identity";
import usdcSource from "@shared/data/stablecoins/coins/usdc-circle.json";
import usdcRiskReview from "@shared/data/stablecoins/domains/risk-review/usdc-circle.json";
import type { AdapterContext, AdapterResult } from "./types";
import { rethrowIfAborted } from "../../lib/abort";
import { finiteDecimalNumberFromBigInt } from "../../lib/bigint";
import { parseDecimalNumber, parseDigitString } from "./strict-amount";
import { encodeBalanceOfCallData, encodeUint256 } from "../../lib/evm-selectors";
import {
  fetchEvmBlockNumber,
  fetchEvmBlockHeader,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeAtBlock,
  fetchEvmStorageAtBlock,
  type EvmBlockHeader,
} from "../../lib/evm-rpc";
import {
  buildRedemptionSnapshotMetadata,
  fetchJsonWithRetry,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  reserveInfoWarning,
  verifiedFreshnessMetadata,
} from "./helpers";
import { decodeAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { runAdapterIo } from "./concurrency";
import { normalizeEvmAddress, resolveCoinContractAddress } from "./evm";
import { fetchOnchainMulticall3, fetchOnchainUint256 } from "./onchain";
import { EIP1967_BEACON_SLOT, multicallResultByLabel, runtimeCodeHash } from "./onchain-identity";
import { ERC4626_CONVERT_TO_ASSETS_SELECTOR as CONVERT_TO_ASSETS_SELECTOR } from "./erc4626";

const optionalTextSchema = z.string().trim().min(1).nullish().catch(null).transform((value) => value ?? null);
const chainIdSchema = z.union([
  z.string().trim().min(1),
  z.number().finite().transform(String),
]).nullish().catch(null).transform((value) => value ?? null);
const tokenSchema = z.object({
  address: optionalTextSchema,
  chainId: chainIdSchema,
  symbol: optionalTextSchema,
}).nullish().catch(null).transform((value) => value ?? null);
type MakinaToken = z.output<typeof tokenSchema>;
// Reuse authored deployments and reviewed issuance identities, not a symbol
// alias or another hand-maintained USDC address roster. Representations stay out.
const canonicalUsdcDeployments: Record<string, true> = Object.fromEntries(
  usdcRiskReview.bridgeRouteRisk.routes.flatMap((route) => {
    const chain = CHAIN_META[route.destinationChain];
    if (route.reviewDisposition !== "reviewed" || route.issuanceModel !== "native-issuance"
      || route.routeClass !== "native" || route.semantics !== "native-mint" || chain?.evmChainId == null
      || !usdcSource.contracts.some((deployment) =>
        deployment.chain === route.destinationChain && deployment.address.toLowerCase() === route.contractAddress.toLowerCase()
      )) return [];
    return [[`${chain.evmChainId}:${route.contractAddress.toLowerCase()}`, true]];
  }),
);

const rawAmountSchema = z.string().trim().regex(/^\d+$/).transform((value) =>
  parseDigitString(value, "makina-strategy invalid raw amount")
);
const timestampSchema = z.unknown().transform((value) => parseTimestampLikeToUnixSeconds(value))
  .pipe(z.number().finite().positive());
const generatedAtSchema = z.object({ generated_at: timestampSchema });
const protocolSchema = optionalTextSchema.transform((value) => value?.toLowerCase() ?? null);
const strategySchema = z.object({
  data: z.object({
    address: z.string().trim().min(1),
    aum: rawAmountSchema,
    lastReportedAum: rawAmountSchema.nullish(),
    shareSupply: rawAmountSchema,
    shareLimit: rawAmountSchema,
    sharePrice: z.unknown().transform((value) => parseDecimalNumber(value)).pipe(z.number().finite().positive()),
    accountingToken: z.object({
      address: optionalTextSchema,
      chainId: chainIdSchema,
      symbol: optionalTextSchema,
      decimals: z.number().int().min(0).max(36).optional(),
    }),
    apy7d: z.number().finite().optional().catch(undefined),
    apy30d: z.number().finite().optional().catch(undefined),
  }),
  meta: generatedAtSchema,
});
const baseTokenSchema = z.object({
  accounting_token_value: rawAmountSchema,
  protocol: protocolSchema,
  token: tokenSchema,
});
const positionSchema = z.object({
  value: rawAmountSchema,
  is_debt: z.unknown().optional(),
  id: optionalTextSchema,
  chain_id: chainIdSchema,
  protocol: protocolSchema,
  strategy: optionalTextSchema,
  type: optionalTextSchema,
  updated_at: z.number().finite().nullish().catch(null).transform((value) => value ?? null),
  updated_at_block: optionalTextSchema,
  token: tokenSchema,
}).transform((row, ctx) => {
  if (row.value === 0n) return null;
  if (typeof row.is_debt !== "boolean") {
    ctx.addIssue({ code: "custom", path: ["is_debt"], message: "makina-strategy positive position requires boolean is_debt" });
    return z.NEVER;
  }
  return { ...row, is_debt: row.is_debt };
});
const allocationsSchema = z.object({
  data: z.object({
    base_tokens: z.array(baseTokenSchema),
    positions: z.array(positionSchema).transform((rows) => rows.filter((row) => row != null)),
  }),
  meta: generatedAtSchema,
});

function normalizeMakinaInput(strategy: unknown, allocations: unknown, params: MakinaStrategyParams) {
  const strategyWire = strategySchema.parse(strategy);
  const allocationWire = allocationsSchema.parse(allocations);
  const decimals = params.accountingTokenDecimals
    ?? strategyWire.data.accountingToken.decimals
    ?? DEFAULT_ACCOUNTING_DECIMALS;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("makina-strategy invalid accounting token decimals");
  }
  const amount = (value: bigint, scale = decimals): number => {
    const result = finiteDecimalNumberFromBigInt(value, scale);
    if (result == null) throw new Error("makina-strategy invalid accounting value");
    return result;
  };
  return {
    strategyData: {
      ...strategyWire.data,
      aum: amount(strategyWire.data.aum),
      lastReportedAum: strategyWire.data.lastReportedAum == null ? null : amount(strategyWire.data.lastReportedAum),
      shareSupply: amount(strategyWire.data.shareSupply, 18),
      shareLimit: amount(strategyWire.data.shareLimit, 18),
    },
    allocationData: {
      base_tokens: allocationWire.data.base_tokens.map((row) => ({
        ...row, accounting_token_value: amount(row.accounting_token_value),
      })),
      positions: allocationWire.data.positions.map((row) => ({ ...row, value: amount(row.value) })),
    },
    sourceTimestamp: Math.min(strategyWire.meta.generated_at, allocationWire.meta.generated_at),
  };
}

type MakinaBucketKind = "protocol" | "base-token" | "unknown" | "other";

interface MakinaBucketValue {
  key: string;
  name: string;
  value: number;
  risk: ReserveSlice["risk"];
  kind: MakinaBucketKind;
  coinId?: string;
  depType?: ReserveSlice["depType"];
  sourceKey?: string;
}

type MakinaStrategyParams = LiveReserveAdapterParamsByKey["makina-strategy"];

export interface MakinaMachineAccounting {
  aumUsd: number;
  accountedAt: number;
  blockNumber: number;
  blockTimestamp: number;
  blockHash?: string;
}

export interface MakinaRedemptionState {
  machineAccounting?: MakinaMachineAccounting;
  whitelistEnabled: boolean;
  sanctionsCheckEnabled: boolean;
  minimumFinalizationDelaySec: number;
  nextRequestId: number;
  lastFinalizedRequestId: number;
  pendingRequestCount: number;
  lockedShares: number;
  grossIdleCapacityUsd: number;
  queueDepthUsd: number;
  reservedUnclaimedUsdc: number;
  minimumRedeemShares: number;
  capacityUsd: number;
  blockNumber: number;
  asyncRedeemerAddress: string;
  implementationAddress: string;
  implementationRuntimeCodeHash: string;
}

interface MakinaRedemptionRead {
  state: MakinaRedemptionState | null;
  /** Same-run Machine AUM anchor, retained when only the redeemer proof fails. */
  machineAccounting?: MakinaMachineAccounting;
  warning?: LiveReserveWarning;
}

const DEFAULT_ACCOUNTING_DECIMALS = 6;
// Match executable-redemption-observers.ts observation windows; this bounds
// the read block independently of the older reserve-accounting source clock.
const MACHINE_ACCOUNTING_BLOCK_MAX_AGE_SEC = 10 * 60;
const MACHINE_ACCOUNTING_BLOCK_FUTURE_SKEW_SEC = 60;
const DEFAULT_OTHER_THRESHOLD_PCT = 2;
const DEFAULT_RECONCILIATION_TOLERANCE_PCT = 0.5;
const ETHEREUM_CHAIN = "ethereum";
const CANONICAL_ETHEREUM_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const REVIEWED_ASYNC_REDEEMER_IMPLEMENTATION = "0x49c4762ab838f2e5d8252b69b90a1e8587a74511";
const REVIEWED_ASYNC_REDEEMER_IMPLEMENTATION_CODE_HASH =
  "0x395083795e58602401305485b5328241fb589687c9edac0dddede880a083524f";
const REVIEWED_PENDLE_PT_AUSD_MONAD = "143:0x9fc74f8ed616b5baf52a170caa97d6d3898602d1";
const REDEEMER_MACHINE_SELECTOR = "0x75c60225";
const MACHINE_LAST_TOTAL_AUM_SELECTOR = "0x74c59381";
const MACHINE_LAST_GLOBAL_ACCOUNTING_TIME_SELECTOR = "0x1182570e";
const MACHINE_ACCOUNTING_TOKEN_SELECTOR = "0xda68cf8b";
const MACHINE_SHARE_TOKEN_SELECTOR = "0x6c9fa59e";
const IS_WHITELIST_ENABLED_SELECTOR = "0x184d69ab";
const IS_SANCTIONS_CHECK_ENABLED_SELECTOR = "0x1c34eb35";
const FINALIZATION_DELAY_SELECTOR = "0xf9823a5c";
const NEXT_REQUEST_ID_SELECTOR = "0x6a84a985";
const LAST_FINALIZED_REQUEST_ID_SELECTOR = "0x667a739e";
const MIN_REDEEM_AMOUNT_SELECTOR = "0x0912ae6d";
const BEACON_IMPLEMENTATION_SELECTOR = "0x5c60da1b";

function readParams(config: LiveReservesConfig): MakinaStrategyParams {
  return parseLiveReserveAdapterParams("makina-strategy", config.params);
}

function readSafeOnchainNumber(value: bigint | null): number | null {
  if (value == null || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

function redemptionTelemetryUnavailable(
  message: string,
  machineAccounting?: MakinaMachineAccounting,
): MakinaRedemptionRead {
  return {
    state: null,
    ...(machineAccounting ? { machineAccounting } : {}),
    warning: reserveInfoWarning("makina-redemption-telemetry-unavailable", message),
  };
}

/**
 * Machine `lastTotalAum`/`lastGlobalAccountingTime` is independent of the
 * AsyncRedeemer: the identity checks that precede this anchor prove canonical
 * Ethereum USDC and the tracked share token. Incomplete accounting evidence
 * cannot create an anchor.
 */
function buildMachineAccounting(args: {
  accountingDecimals: number;
  machineAumRaw: bigint | null;
  machineAccountedAt: number | null;
  blockHeader: EvmBlockHeader | null;
  blockNumber: number;
  nowSec: number;
}): MakinaMachineAccounting | undefined {
  const machineAumUsd = args.machineAumRaw == null ? null : finiteDecimalNumberFromBigInt(args.machineAumRaw, 6);
  return args.accountingDecimals === 6 && args.blockHeader != null &&
    Number.isFinite(args.nowSec) && args.nowSec > 0 &&
    args.blockHeader.timestamp <= args.nowSec + MACHINE_ACCOUNTING_BLOCK_FUTURE_SKEW_SEC &&
    args.nowSec - args.blockHeader.timestamp <= MACHINE_ACCOUNTING_BLOCK_MAX_AGE_SEC &&
    machineAumUsd != null && machineAumUsd > 0 && args.machineAccountedAt != null &&
    args.machineAccountedAt > 0 && args.machineAccountedAt <= args.blockHeader.timestamp
    ? {
        aumUsd: machineAumUsd,
        accountedAt: args.machineAccountedAt,
        blockNumber: args.blockNumber,
        blockTimestamp: args.blockHeader.timestamp,
        blockHash: args.blockHeader.hash,
      }
    : undefined;
}

/** Machine accounting read from the same Multicall3 batch as the redeemer route. */
function readMachineAccountingFromBatch(args: {
  reads: Parameters<typeof multicallResultByLabel>[0];
  accountingDecimals: number;
  blockHeader: EvmBlockHeader | null;
  blockNumber: number;
  nowSec: number;
}): MakinaMachineAccounting | undefined {
  return buildMachineAccounting({
    accountingDecimals: args.accountingDecimals,
    machineAumRaw: decodeUint256Word(multicallResultByLabel(args.reads, "machine-last-total-aum")),
    machineAccountedAt: readSafeOnchainNumber(decodeUint256Word(
      multicallResultByLabel(args.reads, "machine-last-global-accounting-time"),
    )),
    blockHeader: args.blockHeader,
    blockNumber: args.blockNumber,
    nowSec: args.nowSec,
  });
}

export function buildMakinaRedemptionMetadata(state: MakinaRedemptionState) {
  return {
    ...buildRedemptionSnapshotMetadata({
      capacityUsd: state.capacityUsd,
      settlementBoundUnproven: true,
      capacityKind: "live-queue",
      freshnessKind: "same-run-onchain",
      blockNumber: state.blockNumber,
      holderEligibility: state.whitelistEnabled ? "whitelisted-primary" : "any-holder",
      queueDepthUsd: state.queueDepthUsd,
      routeStatus: state.whitelistEnabled ? "cohort-limited" : "open",
      routeStatusSource: "onchain",
      routeObserved: true,
      routeStatusReason: state.whitelistEnabled
        ? "AsyncRedeemer whitelist is enabled; requests and claims are limited to the active allowlist"
        : state.sanctionsCheckEnabled
          ? "AsyncRedeemer whitelist is disabled and its sanctions check is enabled"
          : "AsyncRedeemer whitelist and sanctions check are disabled",
      sourceUrls: [
        "https://docs.makina.finance/concepts/architecture/machine/redemptions",
        `https://eth.blockscout.com/address/${state.asyncRedeemerAddress}?tab=contract`,
        `https://eth.blockscout.com/address/${state.implementationAddress}?tab=contract`,
      ],
    }),
    redemptionQueue: {
      nextRequestId: state.nextRequestId,
      lastFinalizedRequestId: state.lastFinalizedRequestId,
      unfinalizedRequestSpan: state.pendingRequestCount,
      pendingRequestCount: state.pendingRequestCount,
      minimumFinalizationDelaySec: state.minimumFinalizationDelaySec,
      minimumRedeemShares: state.minimumRedeemShares,
      lockedShares: state.lockedShares,
      grossIdleCapacityUsd: state.grossIdleCapacityUsd,
      queueDepthUsd: state.queueDepthUsd,
      reservedUnclaimedUsdc: state.reservedUnclaimedUsdc,
      settlementBoundUnproven: true,
      usableCapacityFormula: "max(0, Machine idle Ethereum USDC - convertToAssets(DUSD locked in AsyncRedeemer))",
      capacityBasis: "live-proxy-buffer",
      implementationAddress: state.implementationAddress,
      implementationRuntimeCodeHash: state.implementationRuntimeCodeHash,
      whitelistEnabled: state.whitelistEnabled,
      sanctionsCheckEnabled: state.sanctionsCheckEnabled,
    },
  };
}

async function fetchMakinaRedemptionState(
  coin: ReserveAdapterCoin,
  params: MakinaStrategyParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<MakinaRedemptionRead> {
  if (!params.asyncRedeemerAddress) return { state: null };

  try {
    const machineAddress = normalizeEvmAddress(params.machineAddress);
    const asyncRedeemerAddress = normalizeEvmAddress(params.asyncRedeemerAddress);
    const shareTokenAddress = normalizeEvmAddress(resolveCoinContractAddress(coin, ETHEREUM_CHAIN) ?? undefined);
    if (!machineAddress || !asyncRedeemerAddress || !shareTokenAddress) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry skipped: missing reviewed Ethereum addresses");
    }

    const rpcOptions = {
      signal,
      timeoutMs: 10_000,
      chainRpcs: ctx?.chainRpcs,
    };
    const blockNumber = await runAdapterIo(
      ctx,
      "makina-redemption-block:ethereum",
      () => fetchEvmBlockNumber(ETHEREUM_CHAIN, rpcOptions),
      { signal },
    );
    if (blockNumber == null) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: Ethereum block pin failed");
    }

    const blockHeader = await runAdapterIo(
      ctx,
      `makina-accounting-block-header:${blockNumber}`,
      () => fetchEvmBlockHeader(ETHEREUM_CHAIN, blockNumber, rpcOptions),
      { signal },
    );

    const [reads, beaconSlot] = await Promise.all([
      fetchOnchainMulticall3({
        chain: ETHEREUM_CHAIN,
        signal,
        ctx,
        blockNumberOrTag: blockNumber,
        calls: [
          { label: "redeemer-machine", contract: asyncRedeemerAddress, data: REDEEMER_MACHINE_SELECTOR },
          { label: "machine-accounting-token", contract: machineAddress, data: MACHINE_ACCOUNTING_TOKEN_SELECTOR },
          { label: "machine-last-total-aum", contract: machineAddress, data: MACHINE_LAST_TOTAL_AUM_SELECTOR },
          { label: "machine-last-global-accounting-time", contract: machineAddress, data: MACHINE_LAST_GLOBAL_ACCOUNTING_TIME_SELECTOR },
          { label: "machine-share-token", contract: machineAddress, data: MACHINE_SHARE_TOKEN_SELECTOR },
          { label: "machine-idle-usdc", contract: CANONICAL_ETHEREUM_USDC, data: encodeBalanceOfCallData(machineAddress) },
          { label: "redeemer-locked-shares", contract: shareTokenAddress, data: encodeBalanceOfCallData(asyncRedeemerAddress) },
          { label: "redeemer-reserved-usdc", contract: CANONICAL_ETHEREUM_USDC, data: encodeBalanceOfCallData(asyncRedeemerAddress) },
          { label: "redeemer-whitelist", contract: asyncRedeemerAddress, data: IS_WHITELIST_ENABLED_SELECTOR },
          { label: "redeemer-sanctions-check", contract: asyncRedeemerAddress, data: IS_SANCTIONS_CHECK_ENABLED_SELECTOR },
          { label: "redeemer-finalization-delay", contract: asyncRedeemerAddress, data: FINALIZATION_DELAY_SELECTOR },
          { label: "redeemer-next-request-id", contract: asyncRedeemerAddress, data: NEXT_REQUEST_ID_SELECTOR },
          { label: "redeemer-last-finalized-request-id", contract: asyncRedeemerAddress, data: LAST_FINALIZED_REQUEST_ID_SELECTOR },
          { label: "redeemer-min-redeem-amount", contract: asyncRedeemerAddress, data: MIN_REDEEM_AMOUNT_SELECTOR },
        ],
      }),
      runAdapterIo(
        ctx,
        `makina-redemption-beacon-slot:${asyncRedeemerAddress}`,
        () => fetchEvmStorageAtBlock(ETHEREUM_CHAIN, asyncRedeemerAddress, EIP1967_BEACON_SLOT, blockNumber, rpcOptions),
        { signal },
      ),
    ]);
    if (!reads) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: same-block route state read failed");
    }

    const accountingDecimals = params.accountingTokenDecimals ?? DEFAULT_ACCOUNTING_DECIMALS;
    // The Machine accounting read is part of the same batch and does not need
    // the reviewed AsyncRedeemer: keep it when only the redeemer proof fails.
    const machineAccounting = readMachineAccountingFromBatch({
      reads,
      accountingDecimals,
      blockHeader,
      blockNumber,
      nowSec: ctx?.nowSec ?? Math.floor(Date.now() / 1000),
    });

    const redeemerMachine = decodeAddressWord(multicallResultByLabel(reads, "redeemer-machine"));
    if (redeemerMachine !== machineAddress) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry withheld: redeemer machine() does not match the configured Machine");
    }
    const accountingToken = decodeAddressWord(multicallResultByLabel(reads, "machine-accounting-token"));
    if (accountingToken !== CANONICAL_ETHEREUM_USDC) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry withheld: Machine accounting token is not canonical Ethereum USDC");
    }
    const shareToken = decodeAddressWord(multicallResultByLabel(reads, "machine-share-token"));
    if (shareToken !== shareTokenAddress) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry withheld: Machine share token does not match the tracked DUSD contract");
    }

    const beaconAddress = decodeAddressWord(beaconSlot);
    if (!beaconAddress) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry withheld: AsyncRedeemer proxy beacon was not resolved");
    }
    const implementationRaw = await runAdapterIo(
      ctx,
      `makina-redemption-beacon-implementation:${beaconAddress}`,
      () => fetchEvmCallHexAtBlock(
        ETHEREUM_CHAIN,
        beaconAddress,
        BEACON_IMPLEMENTATION_SELECTOR,
        blockNumber,
        rpcOptions,
      ),
      { signal },
    );
    const implementationAddress = decodeAddressWord(implementationRaw);
    if (implementationAddress !== REVIEWED_ASYNC_REDEEMER_IMPLEMENTATION) {
      return redemptionTelemetryUnavailable(
        "Makina AsyncRedeemer telemetry withheld: proxy implementation changed from the reviewed standard AsyncRedeemer",
        machineAccounting,
      );
    }
    const implementationCode = await runAdapterIo(
      ctx,
      `makina-redemption-implementation-code:${implementationAddress}`,
      () => fetchEvmCodeAtBlock(ETHEREUM_CHAIN, implementationAddress, blockNumber, rpcOptions),
      { signal },
    );
    const implementationRuntimeCodeHash = runtimeCodeHash(implementationCode);
    if (implementationRuntimeCodeHash !== REVIEWED_ASYNC_REDEEMER_IMPLEMENTATION_CODE_HASH) {
      return redemptionTelemetryUnavailable(
        "Makina AsyncRedeemer telemetry withheld: reviewed AsyncRedeemer runtime code hash did not match",
        machineAccounting,
      );
    }

    const lockedSharesRaw = decodeUint256Word(multicallResultByLabel(reads, "redeemer-locked-shares"));
    if (lockedSharesRaw == null) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: locked DUSD share balance read failed");
    }
    const queueDepthRaw = await fetchOnchainUint256({
      contract: machineAddress,
      data: `${CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(lockedSharesRaw)}`,
      signal,
      ctx,
      chain: ETHEREUM_CHAIN,
      blockNumberOrTag: blockNumber,
    });
    if (queueDepthRaw == null) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: queued-share liability conversion failed");
    }

    const whitelistEnabled = decodeStrictBoolWord(multicallResultByLabel(reads, "redeemer-whitelist"));
    const sanctionsCheckEnabled = decodeStrictBoolWord(multicallResultByLabel(reads, "redeemer-sanctions-check"));
    const minimumFinalizationDelaySec = readSafeOnchainNumber(decodeUint256Word(
      multicallResultByLabel(reads, "redeemer-finalization-delay"),
    ));
    const nextRequestId = readSafeOnchainNumber(decodeUint256Word(
      multicallResultByLabel(reads, "redeemer-next-request-id"),
    ));
    const lastFinalizedRequestId = readSafeOnchainNumber(decodeUint256Word(
      multicallResultByLabel(reads, "redeemer-last-finalized-request-id"),
    ));
    const minimumRedeemRaw = decodeUint256Word(multicallResultByLabel(reads, "redeemer-min-redeem-amount"));
    const machineIdleRaw = decodeUint256Word(multicallResultByLabel(reads, "machine-idle-usdc"));
    const reservedUnclaimedRaw = decodeUint256Word(multicallResultByLabel(reads, "redeemer-reserved-usdc"));
    if (
      whitelistEnabled == null ||
      sanctionsCheckEnabled == null ||
      minimumFinalizationDelaySec == null ||
      nextRequestId == null ||
      lastFinalizedRequestId == null ||
      minimumRedeemRaw == null ||
      machineIdleRaw == null ||
      reservedUnclaimedRaw == null ||
      lastFinalizedRequestId >= nextRequestId
    ) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: route counters or balances failed validation");
    }

    const grossIdleCapacityUsd = finiteDecimalNumberFromBigInt(machineIdleRaw, accountingDecimals);
    const queueDepthUsd = finiteDecimalNumberFromBigInt(queueDepthRaw, accountingDecimals);
    const reservedUnclaimedUsdc = finiteDecimalNumberFromBigInt(reservedUnclaimedRaw, accountingDecimals);
    const lockedShares = finiteDecimalNumberFromBigInt(lockedSharesRaw, 18);
    const minimumRedeemShares = finiteDecimalNumberFromBigInt(minimumRedeemRaw, 18);
    if (
      grossIdleCapacityUsd == null ||
      queueDepthUsd == null ||
      reservedUnclaimedUsdc == null ||
      lockedShares == null ||
      minimumRedeemShares == null
    ) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: route amounts failed decimal normalization");
    }

    return {
      state: {
        ...(machineAccounting ? { machineAccounting } : {}),
        whitelistEnabled,
        sanctionsCheckEnabled,
        minimumFinalizationDelaySec,
        nextRequestId,
        lastFinalizedRequestId,
        pendingRequestCount: nextRequestId - lastFinalizedRequestId - 1,
        lockedShares,
        grossIdleCapacityUsd,
        queueDepthUsd,
        reservedUnclaimedUsdc,
        minimumRedeemShares,
        capacityUsd: Math.max(0, grossIdleCapacityUsd - queueDepthUsd),
        blockNumber,
        asyncRedeemerAddress,
        implementationAddress,
        implementationRuntimeCodeHash,
      },
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return redemptionTelemetryUnavailable(
      `Makina AsyncRedeemer telemetry unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function displayProtocol(protocol: string): string {
  switch (protocol) {
    case "aave-v3":
      return "Aave V3 positions";
    case "aave-v4":
      return "Aave V4 positions";
    case "morpho":
      return "Morpho lending positions";
    case "fluid-lite":
      return "Fluid Lite positions";
    case "makina":
      return "Makina Machine exposure";
    case "pareto":
      return "Pareto / FalconX credit exposure";
    case "pendle":
      return "Pendle positions";
    case "re":
      return "Re Protocol exposure";
    case "royco":
      return "Royco incentive positions";
    default:
      return `${protocol} positions`;
  }
}

function protocolRisk(protocol: string): ReserveSlice["risk"] {
  switch (protocol) {
    case "aave-v3":
    case "aave-v4":
    case "morpho":
      return "medium";
    case "pendle":
      return "high";
    case "pareto":
    case "re":
    case "royco":
      return "high";
    default:
      return "high";
  }
}

function pushBucket(
  buckets: Map<string, MakinaBucketValue>,
  value: Omit<MakinaBucketValue, "value">,
  amount: number,
): void {
  if (!Number.isFinite(amount) || amount === 0) return;
  const existing = buckets.get(value.key);
  if (existing) {
    existing.value += amount;
    return;
  }
  buckets.set(value.key, { ...value, value: amount });
}

function isKnownAccountingToken(token: MakinaToken | undefined): boolean {
  return token?.chainId != null && token.address != null
    && canonicalUsdcDeployments[`${token.chainId}:${token.address.toLowerCase()}`] === true;
}

function reserveSliceFromBucket(bucket: MakinaBucketValue): ReserveSlice {
  return {
    ...(bucket.sourceKey ? { sourceKey: bucket.sourceKey } : {}),
    name: bucket.name,
    pct: bucket.value,
    risk: bucket.risk,
    ...(bucket.coinId ? { coinId: bucket.coinId } : {}),
    ...(bucket.depType ? { depType: bucket.depType } : {}),
  };
}

function reviewedBaseTokenProtocol(token: MakinaToken | undefined): string | null {
  const chainId = token?.chainId;
  const address = token?.address?.toLowerCase();
  if (!chainId || !address) return null;
  return `${chainId}:${address}` === REVIEWED_PENDLE_PT_AUSD_MONAD ? "pendle" : null;
}

function makeOtherBucket(buckets: MakinaBucketValue[]): MakinaBucketValue {
  const risk = buckets.some((bucket) => bucket.risk === "very-high")
    ? "very-high"
    : buckets.some((bucket) => bucket.risk === "high")
      ? "high"
      : buckets.some((bucket) => bucket.risk === "medium")
        ? "medium"
        : "low";
  return {
    key: "other",
    name: "Other identified Makina positions",
    value: buckets.reduce((sum, bucket) => sum + bucket.value, 0),
    risk,
    kind: "other",
  };
}

export function adaptMakinaStrategyReserves(
  strategy: unknown,
  allocations: unknown,
  params: MakinaStrategyParams,
  redemptionState?: MakinaRedemptionState | null,
  redemptionWarning?: LiveReserveWarning,
  sameRunMachineAccounting?: MakinaMachineAccounting,
): AdapterResult {
  const { strategyData, allocationData, sourceTimestamp: inputTimestamp } = normalizeMakinaInput(strategy, allocations, params);
  const strategyAddress = strategyData.address;
  if (strategyAddress?.toLowerCase() !== params.machineAddress.toLowerCase()) {
    throw new Error("makina-strategy machine address mismatch");
  }

  if (!isKnownAccountingToken(strategyData.accountingToken)
    || strategyData.accountingToken.chainId !== "1"
    || (params.accountingTokenSymbol?.toUpperCase() ?? "USDC") !== "USDC") {
    throw new Error("makina-strategy accounting token mismatch");
  }

  // The result combines accounting state with allocation-driven reserve slices, so
  // its freshness cannot be newer than either source.
  let sourceTimestamp = inputTimestamp;
  const currentAumUsd = strategyData.aum;
  const lastReportedAumUsd = strategyData.lastReportedAum;
  const shareSupply = strategyData.shareSupply;
  const shareLimit = strategyData.shareLimit;
  const sharePrice = strategyData.sharePrice;
  if (currentAumUsd <= 0 || shareSupply <= 0 || sharePrice <= 0) {
    throw new Error("makina-strategy non-positive accounting state");
  }

  const warnings: LiveReserveWarning[] = [];
  const buckets = new Map<string, MakinaBucketValue>();
  let totalDebtUsd = 0;
  let grossAssetsUsd = 0;
  let positionCount = 0;
  let debtPositionCount = 0;
  let missingTimestampPositionCount = 0;
  let oldestPositionUpdatedAt: number | null = null;
  let oldestMaterialPositionUpdatedAt: number | null = null;
  const positionDetails: Array<Record<string, unknown>> = [];
  const chainTotals = new Map<string, number>();

  for (const entry of allocationData.base_tokens) {
    const value = entry.accounting_token_value;
    if (value <= 0) continue;
    grossAssetsUsd += value;
    const chainId = entry.token?.chainId ?? "unknown";
    chainTotals.set(chainId, (chainTotals.get(chainId) ?? 0) + value);
    if (isKnownAccountingToken(entry.token)) {
      pushBucket(buckets, {
        key: "base-token",
        sourceKey: "makina:base-token:usdc",
        name: "Unallocated USDC balances",
        risk: "low",
        kind: "base-token",
        coinId: "usdc-circle",
        depType: "collateral",
      }, value);
      continue;
    }
    const protocol = entry.protocol ?? reviewedBaseTokenProtocol(entry.token);
    if (protocol) {
      pushBucket(buckets, {
        key: `protocol:${protocol}`,
        sourceKey: `makina:protocol:${protocol}`,
        name: displayProtocol(protocol),
        risk: protocolRisk(protocol),
        kind: "protocol",
      }, value);
      continue;
    }
    pushBucket(buckets, {
      key: "unknown",
      sourceKey: "makina:unknown:unlabelled",
      name: "Unknown Makina exposure",
      risk: "high",
      kind: "unknown",
    }, value);
  }

  // Financing has no supported asset-level attribution. Keep the signed book
  // for AUM reconciliation, but compose exposures from gross assets only.
  const assetBuckets = new Map([...buckets].map(([key, bucket]) => [key, { ...bucket }]));
  const financingBuckets = new Map<string, MakinaBucketValue>();

  for (const entry of allocationData.positions) {
    const unsignedValue = entry.value;
    if (unsignedValue <= 0) continue;
    positionCount += 1;
    const signedValue = entry.is_debt ? -unsignedValue : unsignedValue;
    if (signedValue < 0) {
      totalDebtUsd += unsignedValue;
      debtPositionCount += 1;
    } else {
      grossAssetsUsd += unsignedValue;
    }
    const chainId = entry.chain_id ?? "unknown";
    chainTotals.set(chainId, (chainTotals.get(chainId) ?? 0) + signedValue);

    const updatedAt = entry.updated_at;
    if (updatedAt == null) missingTimestampPositionCount += 1;
    else if (oldestPositionUpdatedAt == null || updatedAt < oldestPositionUpdatedAt) {
      oldestPositionUpdatedAt = updatedAt;
    }
    const protocol = entry.protocol;
    const name = protocol ? displayProtocol(protocol) : "Unknown Makina exposure";
    const key = protocol ? `protocol:${protocol}` : "unknown";
    const risk = protocol ? protocolRisk(protocol) : "high";
    pushBucket(buckets, {
      key,
      sourceKey: protocol ? `makina:protocol:${protocol}` : "makina:unknown:unlabelled",
      name,
      risk,
      kind: protocol ? "protocol" : "unknown",
    }, signedValue);
    pushBucket(signedValue < 0 ? financingBuckets : assetBuckets, {
      key,
      sourceKey: protocol ? `makina:protocol:${protocol}` : "makina:unknown:unlabelled",
      name,
      risk,
      kind: protocol ? "protocol" : "unknown",
    }, unsignedValue);

    positionDetails.push({
      id: entry.id,
      protocol,
      strategy: entry.strategy,
      type: entry.type,
      chainId,
      valueUsd: signedValue,
      isDebt: signedValue < 0,
      updatedAt,
      updatedAtBlock: entry.updated_at_block,
      tokenSymbol: entry.token?.symbol ?? null,
      materialPct: null,
    });
  }

  const netReserveUsd = [...buckets.values()].reduce((sum, bucket) => sum + bucket.value, 0);
  if (!Number.isFinite(netReserveUsd) || netReserveUsd <= 0) {
    throw new Error("makina-strategy produced zero net reserve value");
  }
  const reconciliationDiffPct = Math.abs(netReserveUsd - currentAumUsd) / currentAumUsd * 100;
  const reconciliationTolerancePct =
    params.reconciliationTolerancePct ?? DEFAULT_RECONCILIATION_TOLERANCE_PCT;
  let reconciliationAumUsd = currentAumUsd;
  let reconciliationKind = "allocation-net-value-equals-current-aum";
  const machineAccounting = redemptionState?.machineAccounting ?? sameRunMachineAccounting;
  const onchainDiffPct = machineAccounting
    ? Math.abs(netReserveUsd - machineAccounting.aumUsd) / machineAccounting.aumUsd * 100
    : null;
  if (machineAccounting) {
    // lastTotalAum is the actual mint/redeem authority, adjusted for flows.
    // Never choose an older issuer anchor when the same-run authority disagrees.
    if (onchainDiffPct == null || onchainDiffPct > reconciliationTolerancePct) {
      throw new Error(`makina-strategy allocation net value differs from onchain Machine AUM by ${onchainDiffPct?.toFixed(3)}%`);
    }
    reconciliationAumUsd = machineAccounting.aumUsd;
    reconciliationKind = "allocation-net-value-equals-onchain-machine-aum";
    sourceTimestamp = Math.min(sourceTimestamp, machineAccounting.accountedAt);
    const reportedDiffPct = lastReportedAumUsd != null && lastReportedAumUsd > 0
      ? Math.abs(netReserveUsd - lastReportedAumUsd) / lastReportedAumUsd * 100
      : null;
    if (reconciliationDiffPct > reconciliationTolerancePct ||
      (reportedDiffPct != null && reportedDiffPct > reconciliationTolerancePct)) {
      warnings.push(reserveDegradedWarning(
        "makina-api-aum-disagreement",
        `Allocation book reconciles to same-block Machine AUM; issuer current AUM differs by ${reconciliationDiffPct.toFixed(3)}%`
          + (reportedDiffPct != null ? ` and issuer last reported AUM by ${reportedDiffPct.toFixed(3)}%` : ""),
      ));
    }
  } else if (reconciliationDiffPct > reconciliationTolerancePct) {
    // Makina assembles `aum` on demand from idle balances plus Caliber
    // accounting (docs.makina.finance/concepts/architecture/machine/share-price),
    // so deposits and redemptions move it immediately, while allocation
    // positions are re-accounted only on the operator's batch cadence. Between
    // accountings the position book reconciles to `lastReportedAum` — the
    // on-chain AUM the book was accounted against — rather than to the
    // indexer's live AUM. Accept that anchor with a degraded lag warning
    // instead of erroring through every flow window (production error plateaus
    // on 2026-09-21..22 and 2026-09-26 sat 0.5-0.7% apart for hours); a book
    // matching neither issuer anchor still aborts the run.
    const reportedDiffPct = lastReportedAumUsd != null && lastReportedAumUsd > 0
      ? Math.abs(netReserveUsd - lastReportedAumUsd) / lastReportedAumUsd * 100
      : null;
    if (lastReportedAumUsd != null && reportedDiffPct != null && reportedDiffPct <= reconciliationTolerancePct) {
      reconciliationAumUsd = lastReportedAumUsd;
      reconciliationKind = "allocation-net-value-equals-last-reported-aum";
      warnings.push(reserveDegradedWarning(
        "makina-allocation-aum-lag",
        `Makina allocation book reconciles to the last reported AUM but lags the current AUM`
          + ` by ${reconciliationDiffPct.toFixed(3)}%`,
      ));
    } else {
      throw new Error(
        `makina-strategy allocation net value differs from current AUM by ${reconciliationDiffPct.toFixed(3)}%`
          + (reportedDiffPct != null
            ? ` and from last reported AUM by ${reportedDiffPct.toFixed(3)}%`
            : ""),
      );
    }
  }

  const otherThresholdPct = params.otherThresholdPct ?? DEFAULT_OTHER_THRESHOLD_PCT;
  const positiveBuckets = [...assetBuckets.values()].filter((bucket) => bucket.value > 0);
  const unknownBuckets = positiveBuckets.filter((bucket) => bucket.kind === "unknown");
  const knownBuckets = positiveBuckets.filter((bucket) => bucket.kind !== "unknown");
  const major = knownBuckets.filter((bucket) => (bucket.value / grossAssetsUsd) * 100 >= otherThresholdPct);
  const minor = knownBuckets.filter((bucket) => (bucket.value / grossAssetsUsd) * 100 < otherThresholdPct);
  const displayedBuckets = [
    ...major,
    ...(minor.length > 0 ? [makeOtherBucket(minor)] : []),
    ...unknownBuckets,
  ];
  const unknownExposureUsd = unknownBuckets.reduce((sum, bucket) => sum + bucket.value, 0);
  const unknownExposurePct = unknownExposureUsd / grossAssetsUsd * 100;
  if (unknownExposurePct >= otherThresholdPct) {
    warnings.push(reserveInfoWarning(
      "makina-unknown-exposure",
      `Makina allocation includes ${unknownExposurePct.toFixed(2)}% unlabelled exposure`,
    ));
  }
  if (missingTimestampPositionCount > 0) {
    warnings.push(reserveDegradedWarning(
      "makina-position-timestamp-missing",
      `Makina allocation omitted updated_at for ${missingTimestampPositionCount} of ${positionCount} positions;`
        + " position-accounting freshness cannot be fully bounded",
    ));
  }
  if (redemptionWarning) {
    warnings.push(redemptionWarning);
  }

  for (const detail of positionDetails) {
    const valueUsd = typeof detail.valueUsd === "number" ? Math.abs(detail.valueUsd) : 0;
    const materialPct = valueUsd / netReserveUsd * 100;
    detail.materialPct = materialPct;
    if (
      materialPct >= otherThresholdPct &&
      typeof detail.updatedAt === "number" &&
      (oldestMaterialPositionUpdatedAt == null || detail.updatedAt < oldestMaterialPositionUpdatedAt)
    ) {
      oldestMaterialPositionUpdatedAt = detail.updatedAt;
    }
  }

  // The API envelopes can be regenerated without the underlying Caliber
  // positions being re-accounted. Bound reserve freshness by the oldest
  // position update so a freshly indexed response cannot make stale on-chain
  // accounting appear current.
  if (oldestPositionUpdatedAt != null) {
    sourceTimestamp = Math.min(sourceTimestamp, oldestPositionUpdatedAt);
  }

  return {
    slices: normalizeSlices(
      displayedBuckets.map((bucket) => reserveSliceFromBucket({
        ...bucket,
        value: bucket.value / grossAssetsUsd * 100,
      })),
    ),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd: netReserveUsd,
      totalAssetsUsd: grossAssetsUsd,
      totalLiabilitiesUsd: totalDebtUsd,
      totalDebtUsd,
      shareSupply,
      shareLimit,
      referenceNavUsd: sharePrice,
      sharePrice,
      currentAumUsd,
      reportedAumUsd: lastReportedAumUsd ?? currentAumUsd,
      ...(lastReportedAumUsd != null ? { lastReportedAumUsd } : {}),
      apy7d: strategyData.apy7d,
      apy30d: strategyData.apy30d,
      unknownExposurePct,
      ...(redemptionState ? buildMakinaRedemptionMetadata(redemptionState) : {}),
      details: {
        proofKind: "makina-strategy-accounting-api",
        compositionScope: "gross-assets",
        compositionDenominatorUsd: grossAssetsUsd,
        financingScope: "unallocated-protocol-debt",
        netAumUsd: netReserveUsd,
        financingBuckets: [...financingBuckets.values()].map((bucket) => ({
          key: bucket.key,
          name: bucket.name,
          liabilityUsd: bucket.value,
        })),
        reconciliationKind,
        reconciliationDiffPct,
        reconciliationAumUsd,
        ...(machineAccounting ? {
          onchainMachineAumUsd: machineAccounting.aumUsd,
          onchainMachineAumDiffPct: onchainDiffPct,
          onchainMachineAccountingTimestamp: machineAccounting.accountedAt,
          onchainMachineAccountingBlock: machineAccounting.blockNumber,
          onchainMachineAccountingBlockTimestamp: machineAccounting.blockTimestamp,
          onchainMachineAccountingBlockHash: machineAccounting.blockHash,
          onchainMachineAccountingSource: `https://eth.blockscout.com/address/${params.machineAddress}?tab=contract`,
        } : {}),
        ...(lastReportedAumUsd != null && lastReportedAumUsd > 0
          ? { lastReportedAumDiffPct: Math.abs(netReserveUsd - lastReportedAumUsd) / lastReportedAumUsd * 100 }
          : {}),
        oldestPositionUpdatedAt,
        oldestMaterialPositionUpdatedAt,
        positionCount,
        debtPositionCount,
        chainTotalsUsd: Object.fromEntries(chainTotals),
        protocolBuckets: displayedBuckets.map((bucket) => ({
          key: bucket.key,
          name: bucket.name,
          valueUsd: bucket.value,
          pct: bucket.value / grossAssetsUsd * 100,
          kind: bucket.kind,
        })),
        positions: positionDetails,
      },
    },
  };
}

export async function fetchMakinaStrategyReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primary = requireJsonInputFromConfig(config, "makina-strategy");
  const params = readParams(config);
  const [strategy, allocations, redemptionRead] = await Promise.all([
    fetchJsonWithRetry<unknown>(primary.url, signal, 12_000, ctx),
    fetchJsonWithRetry<unknown>(params.allocationsUrl, signal, 12_000, ctx),
    fetchMakinaRedemptionState(coin, params, signal, ctx),
  ]);
  return adaptMakinaStrategyReserves(
    strategy,
    allocations,
    params,
    redemptionRead.state,
    redemptionRead.warning,
    redemptionRead.machineAccounting,
  );
}
