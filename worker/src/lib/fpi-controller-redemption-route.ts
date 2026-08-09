import { SAME_NOTIONAL_EXIT_REQUEST_POLICY } from "@shared/lib/redemption-backstop-scoring";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import { buildExitRouteCapacityPoint } from "./exit-route-capacity-point";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { z } from "zod";

const EvmAddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const Bytes32Schema = z.string().regex(/^0x[0-9a-f]{64}$/);
const PINNED_SOURCE_FUTURE_SKEW_SEC = 60;

const FPI_CONTROLLER_ROUTE_REJECTION_CODES = [
  "rpc-unavailable",
  "block-unavailable",
  "block-time-out-of-range",
  "controller-code-unavailable",
  "controller-code-drift",
  "dependency-code-unavailable",
  "dependency-code-drift",
  "controller-state-unavailable",
  "controller-state-invalid",
  "interface-identity-mismatch",
  "oracle-identity-mismatch",
  "oracle-state-invalid",
  "oracle-round-invalid",
  "oracle-stale",
  "controller-oracle-disagreement",
  "cpi-tracker-state-invalid",
  "cpi-tracker-stale",
  "fee-drift",
  "redemption-paused",
  "peg-band-invalid",
  "calculation-mismatch",
  "output-price-invalid",
  "all-in-cost-exceeds-request",
  "capacity-unavailable",
  "capacity-mismatch",
] as const;

const FpiControllerV9RouteStateSchema = z
  .object({
    kind: z.literal("fpi-controller-v1"),
    chain: z.literal("ethereum"),
    controllerAddress: EvmAddressSchema,
    controllerCodeHash: Bytes32Schema,
    blockNumber: z.number().int().nonnegative(),
    blockTimestamp: z.number().int().nonnegative(),
    inputTokenAddress: EvmAddressSchema,
    outputTokenAddress: EvmAddressSchema,
    outputTrackedAssetId: z.literal("frax-frax"),
    fraxPriceFeedAddress: EvmAddressSchema,
    fraxPriceFeedCodeHash: Bytes32Schema,
    fraxPriceFeedRoundId: z.string().regex(/^\d+$/),
    fraxPriceFeedUpdatedAt: z.number().int().positive(),
    fraxPriceFeedAgeSec: z.number().int().nonnegative(),
    fpiPriceFeedAddress: EvmAddressSchema,
    fpiPriceFeedCodeHash: Bytes32Schema,
    fpiPriceFeedRoundId: z.string().regex(/^\d+$/),
    fpiPriceFeedUpdatedAt: z.number().int().positive(),
    fpiPriceFeedAgeSec: z.number().int().nonnegative(),
    maxPriceFeedAgeSec: z.number().int().positive(),
    cpiTrackerAddress: EvmAddressSchema,
    cpiTrackerCodeHash: Bytes32Schema,
    cpiTrackerUpdatedAt: z.number().int().positive(),
    cpiTrackerAgeSec: z.number().int().nonnegative(),
    fullConfidenceCpiTrackerAgeSec: z.number().int().positive(),
    maxCpiTrackerAgeSec: z.number().int().positive(),
    cpiTrackerFreshness: z.enum(["current", "stale-bounded"]),
    modelConfidence: z.enum(["high", "medium"]),
    feeBps: z.number().finite().nonnegative().max(10_000),
    pegPriceUsd: z.number().finite().positive(),
    fpiPriceUsd: z.number().finite().positive(),
    pegDifferenceBps: z.number().finite().nonnegative(),
    pegBandBps: z.number().finite().nonnegative(),
    quoteInputFpi: z.number().finite().positive(),
    quoteOutputFrax: z.number().finite().positive(),
    outputPriceUsd: z.number().finite().positive(),
    allInCostBps: z.number().finite().nonnegative(),
    controllerOutputBalance: z.number().finite().positive(),
    maxRedeemableFpi: z.number().finite().positive(),
    capacityUsd: z.number().finite().positive(),
    sourceUrls: z.array(z.string().url()).min(1),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.pegDifferenceBps > state.pegBandBps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pegDifferenceBps"],
        message: "FPI route state cannot exceed the observed mint/redeem peg band",
      });
    }
    const pinnedSourceAges = [
      ["fraxPriceFeedAgeSec", state.fraxPriceFeedAgeSec, state.fraxPriceFeedUpdatedAt],
      ["fpiPriceFeedAgeSec", state.fpiPriceFeedAgeSec, state.fpiPriceFeedUpdatedAt],
      ["cpiTrackerAgeSec", state.cpiTrackerAgeSec, state.cpiTrackerUpdatedAt],
    ] as const;
    for (const [path, ageSec, updatedAt] of pinnedSourceAges) {
      if (
        updatedAt > state.blockTimestamp + PINNED_SOURCE_FUTURE_SKEW_SEC ||
        ageSec !== Math.max(0, state.blockTimestamp - updatedAt)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: "FPI route source age does not agree with the pinned block timestamp",
        });
      }
    }
    if (
      state.fraxPriceFeedAgeSec > state.maxPriceFeedAgeSec ||
      state.fpiPriceFeedAgeSec > state.maxPriceFeedAgeSec
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxPriceFeedAgeSec"],
        message: "FPI route price feed exceeds its pinned admission age",
      });
    }
    if (
      state.fullConfidenceCpiTrackerAgeSec > state.maxCpiTrackerAgeSec ||
      state.cpiTrackerAgeSec > state.maxCpiTrackerAgeSec
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxCpiTrackerAgeSec"],
        message: "FPI route CPI tracker exceeds its pinned admission bound",
      });
    }
    const expectedCpiTrackerFreshness =
      state.cpiTrackerAgeSec <= state.fullConfidenceCpiTrackerAgeSec
        ? "current"
        : "stale-bounded";
    if (state.cpiTrackerFreshness !== expectedCpiTrackerFreshness) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cpiTrackerFreshness"],
        message: "FPI route CPI tracker freshness does not agree with its pinned age threshold",
      });
    }
    const expectedModelConfidence =
      expectedCpiTrackerFreshness === "current" ? "high" : "medium";
    if (state.modelConfidence !== expectedModelConfidence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelConfidence"],
        message: "FPI route model confidence does not agree with CPI tracker freshness",
      });
    }
    const expectedAllInCostBps = Math.max(
      0,
      (1 - (state.quoteOutputFrax * state.outputPriceUsd) / (state.quoteInputFpi * state.pegPriceUsd)) * 10_000,
    );
    if (Math.abs(state.allInCostBps - expectedAllInCostBps) > 0.000001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allInCostBps"],
        message: "FPI route all-in cost does not agree with its pinned quote and output valuation",
      });
    }
    const expectedCapacityUsd = state.maxRedeemableFpi * state.pegPriceUsd;
    if (Math.abs(state.capacityUsd - expectedCapacityUsd) > Math.max(0.000001, expectedCapacityUsd * 1e-9)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capacityUsd"],
        message: "FPI route capacity must be denominated as input FPI notional at the pinned CPI peg",
      });
    }
  });
export type FpiControllerV9RouteState = z.infer<typeof FpiControllerV9RouteStateSchema>;

export const FpiControllerV9RouteAttemptSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("accepted"),
      attemptedAtSec: z.number().int().nonnegative(),
      state: FpiControllerV9RouteStateSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      attemptedAtSec: z.number().int().nonnegative(),
      rejectionCode: z.enum(FPI_CONTROLLER_ROUTE_REJECTION_CODES),
      blockNumber: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type FpiControllerV9RouteAttempt = z.infer<typeof FpiControllerV9RouteAttemptSchema>;

const ROUTE_REQUESTS_USD = [100_000, 1_000_000, 5_000_000, 25_000_000] as const;

export function parseAcceptedFpiControllerV9RouteState(value: unknown): FpiControllerV9RouteState | null {
  const parsed = FpiControllerV9RouteAttemptSchema.safeParse(value);
  return parsed.success && parsed.data.status === "accepted" ? parsed.data.state : null;
}

export function buildFpiControllerV9ExitRouteObservation(args: {
  state: FpiControllerV9RouteState;
  modeledExitSizeUsd: number | null;
  routeStatus: RedemptionBackstopEntry["routeStatus"];
  resolutionState: RedemptionBackstopEntry["resolutionState"];
  now: number;
}): ExitRouteObservation | null {
  const parsed = FpiControllerV9RouteStateSchema.safeParse(args.state);
  if (
    !parsed.success ||
    args.modeledExitSizeUsd == null ||
    !Number.isFinite(args.modeledExitSizeUsd) ||
    args.modeledExitSizeUsd <= 0
  ) {
    return null;
  }

  const state = parsed.data;
  const requests = [...new Set([...ROUTE_REQUESTS_USD, args.modeledExitSizeUsd])]
    .filter((request) => Number.isFinite(request) && request > 0)
    .sort((left, right) => left - right);
  const withinCost = state.allInCostBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps;
  const capacityCurve = requests.map((request) =>
    buildExitRouteCapacityPoint({
      requestedNotionalUsd: request,
      capacityUsd: withinCost ? state.capacityUsd : 0,
    }),
  );
  const point = capacityCurve.find(
    (candidate) => candidate.requestedNotionalUsd === args.modeledExitSizeUsd,
  );
  if (!point) return null;

  return {
    routeId: "redemption:fpi-frax:fpi-controller:ethereum",
    routeFamily: "protocol-redemption",
    scope: {
      kind: "chain-contract",
      chain: state.chain,
      contractOrPoolId: state.controllerAddress,
      protocol: "frax",
    },
    ...point,
    settlementHorizonSec: SAME_NOTIONAL_EXIT_REQUEST_POLICY.settlementHorizonSec,
    output: {
      kind: "tracked-stablecoin",
      trackedAssetIds: [state.outputTrackedAssetId],
    },
    evidenceKind: "onchain-contract-state",
    executionCostBps: state.feeBps,
    outputUnitValueUsd: state.outputPriceUsd,
    allInCostBps: state.allInCostBps,
    modelConfidence: state.modelConfidence,
    confidence: "high",
    scoreEligible:
      args.resolutionState === "resolved" &&
      args.routeStatus === "open" &&
      withinCost &&
      point.executableUsd > 0,
    observedAt: state.blockTimestamp,
    freshnessSeconds: Math.max(0, Math.floor(args.now) - state.blockTimestamp),
    commonModeKeys: [
      "protocol:frax",
      `chain:${state.chain}`,
      `controller:${state.controllerAddress}`,
      `output:${state.outputTrackedAssetId}`,
    ],
    capacityCurve,
  };
}
