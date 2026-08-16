import { SAME_NOTIONAL_EXIT_REQUEST_POLICY } from "@shared/lib/redemption-backstop-scoring";
import type { ExitRouteCapacityPoint, ExitRouteObservation } from "@shared/types/exit-route";
import { buildExitRouteCapacityPoint } from "@shared/lib/exit-route-capacity-point";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { z } from "zod";

const EvmAddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const Bytes32Schema = z.string().regex(/^0x[0-9a-f]{64}$/);
const RawAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const COST_TOLERANCE = 0.000001;
const VALUE_TOLERANCE_RATIO = 1e-9;
const E18 = 10n ** 18n;

const SFRXUSD_ROUTE_CONTRACT_ROLES = [
  "ethereum-sfrxusd",
  "ethereum-remote-hop",
  "ethereum-frxusd-oft",
  "ethereum-sfrxusd-oft",
  "ethereum-eth-usd-feed",
  "ethereum-eth-usd-aggregator",
  "fraxtal-hop",
  "fraxtal-mint-redeemer",
  "fraxtal-frxusd-lockbox",
  "fraxtal-sfrxusd-lockbox",
  "fraxtal-vault-oracle",
] as const;

const PROXY_CONTRACT_ROLES = new Set<(typeof SFRXUSD_ROUTE_CONTRACT_ROLES)[number]>([
  "ethereum-sfrxusd",
  "ethereum-frxusd-oft",
  "ethereum-sfrxusd-oft",
  "fraxtal-mint-redeemer",
  "fraxtal-frxusd-lockbox",
  "fraxtal-sfrxusd-lockbox",
]);

const SfrxusdRouteBlockSchema = z
  .object({
    chain: z.enum(["ethereum", "fraxtal"]),
    finalityTag: z.literal("finalized"),
    blockNumber: z.number().int().nonnegative(),
    blockTimestamp: z.number().int().positive(),
    blockHash: Bytes32Schema,
  })
  .strict();
export type SfrxusdRouteBlock = z.infer<typeof SfrxusdRouteBlockSchema>;

const SfrxusdRouteContractIdentitySchema = z
  .object({
    role: z.enum(SFRXUSD_ROUTE_CONTRACT_ROLES),
    chain: z.enum(["ethereum", "fraxtal"]),
    address: EvmAddressSchema,
    runtimeCodeHash: Bytes32Schema,
    implementationAddress: EvmAddressSchema.optional(),
    implementationRuntimeCodeHash: Bytes32Schema.optional(),
  })
  .strict()
  .superRefine((identity, ctx) => {
    const requiresImplementation = PROXY_CONTRACT_ROLES.has(identity.role);
    const hasCompleteImplementation =
      identity.implementationAddress != null &&
      identity.implementationRuntimeCodeHash != null;
    if (requiresImplementation !== hasCompleteImplementation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["implementationAddress"],
        message: requiresImplementation
          ? "Upgradeable route identity requires an implementation address and runtime hash"
          : "Direct route identity must not claim an implementation",
      });
    }
  });

const SfrxusdRouteProtocolCostPointSchema = z
  .object({
    requestedNotionalUsd: z.number().finite().positive(),
    inputSharesRaw: RawAmountSchema,
    previewOutputFrxUsdRaw: RawAmountSchema,
    ethereumToFraxtalNativeFeeRaw: RawAmountSchema,
    remoteHopServiceFeeRaw: RawAmountSchema,
    fraxtalToEthereumNativeFeeRaw: RawAmountSchema,
    totalUserNativeFeeRaw: RawAmountSchema,
    totalUserNativeFeeUsd: z.number().finite().nonnegative(),
    redemptionOutputLossUsd: z.number().finite().nonnegative(),
    knownProtocolCostUsd: z.number().finite().nonnegative(),
    knownProtocolCostBps: z.number().finite().nonnegative(),
    transactionGasUsd: z.number().finite().nonnegative().nullable(),
    allInCostBps: z.number().finite().nonnegative().nullable(),
  })
  .strict()
  .superRefine((point, ctx) => {
    const outboundFee = BigInt(point.ethereumToFraxtalNativeFeeRaw);
    const serviceFee = BigInt(point.remoteHopServiceFeeRaw);
    const totalUserFee = BigInt(point.totalUserNativeFeeRaw);
    if (totalUserFee !== outboundFee + serviceFee) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalUserNativeFeeRaw"],
        message: "User-paid native quote must equal the outbound quote plus RemoteHop service fee",
      });
    }
    const expectedKnownCostUsd =
      point.totalUserNativeFeeUsd + point.redemptionOutputLossUsd;
    const expectedKnownCostBps =
      (expectedKnownCostUsd / point.requestedNotionalUsd) * 10_000;
    if (
      Math.abs(point.knownProtocolCostUsd - expectedKnownCostUsd) > COST_TOLERANCE ||
      Math.abs(point.knownProtocolCostBps - expectedKnownCostBps) > COST_TOLERANCE
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knownProtocolCostBps"],
        message: "Known protocol cost does not conserve the quoted native fee and redemption output",
      });
    }
    if ((point.transactionGasUsd == null) !== (point.allInCostBps == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allInCostBps"],
        message: "All-in route cost requires a numeric Ethereum transaction-gas cost",
      });
    }
    const expectedAllInCostBps =
      point.transactionGasUsd == null
        ? null
        : ((point.knownProtocolCostUsd + point.transactionGasUsd) /
            point.requestedNotionalUsd) *
          10_000;
    if (
      expectedAllInCostBps != null &&
      (point.allInCostBps == null ||
        Math.abs(point.allInCostBps - expectedAllInCostBps) > COST_TOLERANCE)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allInCostBps"],
        message: "All-in route cost does not include all known protocol and transaction-gas costs",
      });
    }
  });

function raw18ToNumber(value: bigint): number {
  return Number(value / E18) + Number(value % E18) / 1e18;
}

export const SfrxusdCrosschainV9RouteStateSchema = z
  .object({
    kind: z.literal("sfrxusd-crosschain-v1"),
    routeScope: z
      .object({
        chain: z.literal("ethereum"),
        tokenAddress: EvmAddressSchema,
        outputTrackedAssetId: z.literal("frxusd-frax"),
      })
      .strict(),
    ethereumBlock: SfrxusdRouteBlockSchema,
    fraxtalBlock: SfrxusdRouteBlockSchema,
    crossChainBlockSkewSec: z.number().int().nonnegative(),
    maxCrossChainBlockSkewSec: z.number().int().positive(),
    contractIdentities: z
      .array(SfrxusdRouteContractIdentitySchema)
      .length(SFRXUSD_ROUTE_CONTRACT_ROLES.length),
    ethUsdOracle: z
      .object({
        feedAddress: EvmAddressSchema,
        aggregatorAddress: EvmAddressSchema,
        roundId: RawAmountSchema,
        answeredInRound: RawAmountSchema,
        answerE8: RawAmountSchema,
        updatedAt: z.number().int().positive(),
        ageSec: z.number().int().nonnegative(),
        maxAgeSec: z.number().int().positive(),
        priceUsd: z.number().finite().positive(),
      })
      .strict(),
    vaultOracle: z
      .object({
        oracleAddress: EvmAddressSchema,
        roundId: RawAmountSchema,
        answeredInRound: RawAmountSchema,
        answerE18: RawAmountSchema,
        updatedAt: z.number().int().positive(),
        ageSec: z.number().int().nonnegative(),
        configuredToleranceSec: z.number().int().positive(),
        storedPriceE18: RawAmountSchema,
        storedPriceReadAt: z.number().int().positive(),
        storedPriceAgeSec: z.number().int().nonnegative(),
        storedToLatestDeviationBps: z.number().finite().nonnegative(),
        maxPriceDeviationBps: z.number().finite().nonnegative(),
      })
      .strict(),
    capacity: z
      .object({
        ethereumTotalSupplySharesRaw: RawAmountSchema,
        ethereumSupplyAssetsRaw: RawAmountSchema,
        mintRedeemerTotalAssetsFrxUsdRaw: RawAmountSchema,
        mintRedeemerBalanceFrxUsdRaw: RawAmountSchema,
        mintRedeemerMdwrWithdrawableFrxUsdRaw: RawAmountSchema,
        mintRedeemerMaxRedeemSharesRaw: RawAmountSchema,
        cappedRedeemableSharesRaw: RawAmountSchema,
        cappedPreviewOutputFrxUsdRaw: RawAmountSchema,
        vaultPriceE18: RawAmountSchema,
        capacityUsd: z.number().finite().positive(),
      })
      .strict(),
    mintRedeemerFeeRaw: RawAmountSchema,
    mintRedeemerFeeBps: z.number().finite().nonnegative().max(10_000),
    fraxtalHopNativeBalanceRaw: RawAmountSchema,
    protocolCostCurve: z.array(SfrxusdRouteProtocolCostPointSchema).min(1).max(16),
    missingAllInCostComponents: z
      .array(z.enum(["ethereum-transaction-gas"]))
      .max(1),
    settlementUpperBoundSec: z.number().int().positive().nullable(),
    settlementEvidence: z.enum(["primary-source-sla", "measured-history", "unbounded"]),
    sourceUrls: z.array(z.string().url()).min(1),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (
      state.ethereumBlock.chain !== "ethereum" ||
      state.fraxtalBlock.chain !== "fraxtal"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ethereumBlock"],
        message: "Route blocks must preserve their chain identities",
      });
    }
    const expectedSkew = Math.abs(
      state.ethereumBlock.blockTimestamp - state.fraxtalBlock.blockTimestamp,
    );
    if (
      state.crossChainBlockSkewSec !== expectedSkew ||
      state.crossChainBlockSkewSec > state.maxCrossChainBlockSkewSec
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crossChainBlockSkewSec"],
        message: "Cross-chain block skew disagrees with or exceeds the pinned bound",
      });
    }

    const roles = state.contractIdentities.map((identity) => identity.role);
    const uniqueRoles = new Set(roles);
    if (
      uniqueRoles.size !== SFRXUSD_ROUTE_CONTRACT_ROLES.length ||
      SFRXUSD_ROUTE_CONTRACT_ROLES.some((role) => !uniqueRoles.has(role))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contractIdentities"],
        message: "Route contract identity manifest is incomplete or duplicated",
      });
    }
    for (const identity of state.contractIdentities) {
      const expectedChain = identity.role.startsWith("ethereum-")
        ? "ethereum"
        : "fraxtal";
      if (identity.chain !== expectedChain) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contractIdentities"],
          message: `Route identity ${identity.role} is assigned to the wrong chain`,
        });
      }
    }

    if (
      BigInt(state.ethUsdOracle.answeredInRound) <
        BigInt(state.ethUsdOracle.roundId) ||
      state.ethUsdOracle.updatedAt > state.ethereumBlock.blockTimestamp ||
      state.ethUsdOracle.ageSec !==
        state.ethereumBlock.blockTimestamp - state.ethUsdOracle.updatedAt ||
      state.ethUsdOracle.ageSec > state.ethUsdOracle.maxAgeSec
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ethUsdOracle", "ageSec"],
        message: "ETH/USD oracle round or age is invalid at the pinned Ethereum block",
      });
    }

    const latestVaultPrice = BigInt(state.vaultOracle.answerE18);
    const storedVaultPrice = BigInt(state.vaultOracle.storedPriceE18);
    const expectedDeviationBps =
      Number(
        (storedVaultPrice > latestVaultPrice
          ? storedVaultPrice - latestVaultPrice
          : latestVaultPrice - storedVaultPrice) *
          10_000_000n /
          latestVaultPrice,
      ) / 1_000;
    if (
      BigInt(state.vaultOracle.answeredInRound) <
        BigInt(state.vaultOracle.roundId) ||
      state.vaultOracle.updatedAt > state.fraxtalBlock.blockTimestamp ||
      state.vaultOracle.ageSec !==
        state.fraxtalBlock.blockTimestamp - state.vaultOracle.updatedAt ||
      state.vaultOracle.ageSec > state.vaultOracle.configuredToleranceSec ||
      state.vaultOracle.storedPriceReadAt > state.fraxtalBlock.blockTimestamp ||
      state.vaultOracle.storedPriceAgeSec !==
        state.fraxtalBlock.blockTimestamp -
          state.vaultOracle.storedPriceReadAt ||
      state.vaultOracle.storedPriceAgeSec >
        state.vaultOracle.configuredToleranceSec ||
      Math.abs(
        state.vaultOracle.storedToLatestDeviationBps - expectedDeviationBps,
      ) > COST_TOLERANCE ||
      state.vaultOracle.storedToLatestDeviationBps >
        state.vaultOracle.maxPriceDeviationBps
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vaultOracle"],
        message: "Vault oracle round, age, or stored-price agreement is invalid",
      });
    }

    const inventory = BigInt(
      state.capacity.mintRedeemerTotalAssetsFrxUsdRaw,
    );
    const balance = BigInt(state.capacity.mintRedeemerBalanceFrxUsdRaw);
    const mdwrWithdrawable = BigInt(
      state.capacity.mintRedeemerMdwrWithdrawableFrxUsdRaw,
    );
    const ethereumSupplyShares = BigInt(
      state.capacity.ethereumTotalSupplySharesRaw,
    );
    const maxRedeemShares = BigInt(
      state.capacity.mintRedeemerMaxRedeemSharesRaw,
    );
    const cappedShares = BigInt(state.capacity.cappedRedeemableSharesRaw);
    if (
      inventory <= 0n ||
      inventory !== balance ||
      inventory !== mdwrWithdrawable ||
      cappedShares !==
        (ethereumSupplyShares < maxRedeemShares
          ? ethereumSupplyShares
          : maxRedeemShares)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capacity"],
        message: "Capacity views disagree or are not capped by route input supply",
      });
    }
    const grossCapacityAssetsRaw =
      (cappedShares * BigInt(state.capacity.vaultPriceE18)) / E18;
    const previewCapacityAssetsRaw = BigInt(
      state.capacity.cappedPreviewOutputFrxUsdRaw,
    );
    const expectedCapacityUsd = raw18ToNumber(previewCapacityAssetsRaw);
    if (
      previewCapacityAssetsRaw <= 0n ||
      previewCapacityAssetsRaw > grossCapacityAssetsRaw ||
      Math.abs(state.capacity.capacityUsd - expectedCapacityUsd) >
      Math.max(0.000001, expectedCapacityUsd * VALUE_TOLERANCE_RATIO)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capacity", "capacityUsd"],
        message:
          "Capacity USD does not conserve the capped post-fee preview output",
      });
    }
    const expectedFeeBps =
      (Number(BigInt(state.mintRedeemerFeeRaw)) / 1e18) * 10_000;
    if (
      Math.abs(state.mintRedeemerFeeBps - expectedFeeBps) > COST_TOLERANCE
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mintRedeemerFeeBps"],
        message: "MintRedeemer fee bps disagrees with the pinned raw fee",
      });
    }

    const requests = state.protocolCostCurve.map(
      (point) => point.requestedNotionalUsd,
    );
    if (
      new Set(requests).size !== requests.length ||
      requests.some(
        (request, index) => index > 0 && request <= requests[index - 1],
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocolCostCurve"],
        message: "Route cost points must be unique and strictly increasing",
      });
    }
    const hopBalance = BigInt(state.fraxtalHopNativeBalanceRaw);
    if (
      state.protocolCostCurve.some(
        (point) =>
          BigInt(point.fraxtalToEthereumNativeFeeRaw) > hopBalance,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fraxtalHopNativeBalanceRaw"],
        message: "Fraxtal Hop cannot fund the quoted return message",
      });
    }
    const missingGas = state.missingAllInCostComponents.includes(
      "ethereum-transaction-gas",
    );
    if (
      missingGas !==
        state.protocolCostCurve.some(
          (point) => point.transactionGasUsd == null,
        ) ||
      (missingGas &&
        state.protocolCostCurve.some((point) => point.allInCostBps != null))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["missingAllInCostComponents"],
        message: "All-in cost availability disagrees with the quote curve",
      });
    }
    if (
      (state.settlementUpperBoundSec == null) !==
      (state.settlementEvidence === "unbounded")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["settlementUpperBoundSec"],
        message: "Settlement evidence must state whether an upper bound exists",
      });
    }
  });
export type SfrxusdCrosschainV9RouteState = z.infer<
  typeof SfrxusdCrosschainV9RouteStateSchema
>;

const SFRXUSD_CROSSCHAIN_ROUTE_REJECTION_CODES = [
  "rpc-unavailable",
  "block-unavailable",
  "block-time-out-of-range",
  "block-skew-out-of-range",
  "code-unavailable",
  "code-drift",
  "implementation-unavailable",
  "implementation-drift",
  "state-unavailable",
  "identity-mismatch",
  "route-paused",
  "token-identity-invalid",
  "token-decimals-invalid",
  "oracle-invalid",
  "fee-out-of-bounds",
  "capacity-invalid",
  "quote-unavailable",
  "quote-invalid",
  "native-funding-insufficient",
  "packet-invalid",
] as const;
export type SfrxusdCrosschainRouteRejectionCode =
  (typeof SFRXUSD_CROSSCHAIN_ROUTE_REJECTION_CODES)[number];

const SfrxusdCrosschainV9RouteAttemptSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("accepted"),
        attemptedAtSec: z.number().int().nonnegative(),
        state: SfrxusdCrosschainV9RouteStateSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("rejected"),
        attemptedAtSec: z.number().int().nonnegative(),
        rejectionCode: z.enum(SFRXUSD_CROSSCHAIN_ROUTE_REJECTION_CODES),
        ethereumBlock: SfrxusdRouteBlockSchema.optional(),
        fraxtalBlock: SfrxusdRouteBlockSchema.optional(),
      })
      .strict(),
  ],
);
export type SfrxusdCrosschainV9RouteAttempt = z.infer<
  typeof SfrxusdCrosschainV9RouteAttemptSchema
>;

export function parseAcceptedSfrxusdCrosschainV9RouteState(
  value: unknown,
): SfrxusdCrosschainV9RouteState | null {
  const parsed = SfrxusdCrosschainV9RouteAttemptSchema.safeParse(value);
  return parsed.success && parsed.data.status === "accepted"
    ? parsed.data.state
    : null;
}

export function buildSfrxusdCrosschainV9ExitRouteObservation(args: {
  state: SfrxusdCrosschainV9RouteState;
  modeledExitSizeUsd: number | null;
  routeStatus: RedemptionBackstopEntry["routeStatus"];
  resolutionState: RedemptionBackstopEntry["resolutionState"];
  now: number;
}): ExitRouteObservation | null {
  const parsed = SfrxusdCrosschainV9RouteStateSchema.safeParse(args.state);
  if (
    !parsed.success ||
    args.modeledExitSizeUsd == null ||
    !Number.isFinite(args.modeledExitSizeUsd) ||
    args.modeledExitSizeUsd <= 0
  ) {
    return null;
  }
  const state = parsed.data;
  const modeledExitSizeUsd = args.modeledExitSizeUsd;
  if (
    state.settlementUpperBoundSec == null ||
    state.settlementUpperBoundSec >
      SAME_NOTIONAL_EXIT_REQUEST_POLICY.settlementHorizonSec ||
    state.missingAllInCostComponents.length > 0 ||
    state.protocolCostCurve.some((point) => point.allInCostBps == null)
  ) {
    return null;
  }

  const capacityCurve = state.protocolCostCurve.map((point) =>
    buildExitRouteCapacityPoint({
      requestedNotionalUsd: point.requestedNotionalUsd,
      maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
      capacityUsd: state.capacity.capacityUsd,
      admitted: point.allInCostBps! <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
      executionCostBps: point.allInCostBps!,
    }, { clampNegativeCapacity: true, usdDecimals: null, ratioDecimals: null }),
  );
  const exactPoint = capacityCurve.find(
    (point) => point.requestedNotionalUsd === modeledExitSizeUsd,
  );
  const lowerPoint = [...capacityCurve]
    .reverse()
    .find((point) => point.requestedNotionalUsd < modeledExitSizeUsd);
  const conservativePoint = exactPoint ?? lowerPoint ?? capacityCurve[0];
  if (!conservativePoint) return null;
  const executableUsd = Math.min(
    modeledExitSizeUsd,
    conservativePoint.executableUsd,
  );
  const point: ExitRouteCapacityPoint = {
    requestedNotionalUsd: modeledExitSizeUsd,
    maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
    executableUsd,
    completionRatio: executableUsd / modeledExitSizeUsd,
    ...(executableUsd > 0 && conservativePoint.executionCostBps != null
      ? { executionCostBps: conservativePoint.executionCostBps }
      : {}),
  };

  return {
    routeId: "redemption:sfrxusd-frax:fraxtal-mint-redeem:ethereum",
    routeFamily: "protocol-redemption",
    scope: {
      kind: "chain-contract",
      chain: state.routeScope.chain,
      contractOrPoolId: state.routeScope.tokenAddress,
      protocol: "frax",
    },
    ...point,
    settlementHorizonSec:
      SAME_NOTIONAL_EXIT_REQUEST_POLICY.settlementHorizonSec,
    output: {
      kind: "tracked-stablecoin",
      trackedAssetIds: [state.routeScope.outputTrackedAssetId],
    },
    evidenceKind: "onchain-contract-state",
    ...(point.executionCostBps != null
      ? {
          executionCostBps: point.executionCostBps,
          allInCostBps: point.executionCostBps,
        }
      : {}),
    modelConfidence: "medium",
    confidence: "high",
    scoreEligible:
      args.resolutionState === "resolved" &&
      args.routeStatus === "open" &&
      point.executableUsd > 0,
    observedAt: Math.min(
      state.ethereumBlock.blockTimestamp,
      state.fraxtalBlock.blockTimestamp,
    ),
    freshnessSeconds: Math.max(
      0,
      Math.floor(args.now) -
        Math.min(
          state.ethereumBlock.blockTimestamp,
          state.fraxtalBlock.blockTimestamp,
        ),
    ),
    commonModeKeys: [
      "protocol:frax",
      "chain:ethereum",
      "chain:fraxtal",
      `input:${state.routeScope.tokenAddress}`,
      `output:${state.routeScope.outputTrackedAssetId}`,
    ],
    capacityCurve,
  };
}
