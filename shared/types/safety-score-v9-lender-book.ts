import { z } from "zod";
import { CanonicalChainIdSchema, CanonicalTextSchema, ScoreSchema, Sha256Schema, StrictIsoDateSchema, UnixSecondsSchema } from "./safety-schema-primitives";

const Text = CanonicalTextSchema;
// Structural canonical-form admission; normalization belongs to capture, not wire parsing.
const Address = z.string().regex(/^0x[0-9a-f]{40}$/, "Canonical EVM address required");
const Word = z.string().regex(/^0x[0-9a-f]{64}$/);
const UINT256_MAX = (1n << 256n) - 1n;
const WAD = 10n ** 18n;
const Raw = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78).refine(
  (value) => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78 && BigInt(value) <= UINT256_MAX,
  { message: "Raw quantity must fit uint256", abort: true },
);
const Clock = UnixSecondsSchema.max(Number.MAX_SAFE_INTEGER);
const Kind = z.enum(["vault-v2", "metamorpho-v1", "metamorpho-v1.1"]);

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function fail(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

const LenderCollateralClassSchema = z.enum([
  "native-eth", "btc-wrapper", "eth-lst", "eth-yield-or-restaked",
  "major-alt-l1", "precious-metal-receipt", "synthetic-dollar",
  "principal-token", "yield-bearing-stable", "structured-credit", "other-unknown",
]);
export type LenderCollateralClass = z.output<typeof LenderCollateralClassSchema>;

export const LenderCollateralClassReviewSchema = z.strictObject({
  chain: CanonicalChainIdSchema, address: Address, class: LenderCollateralClassSchema,
  reviewedAt: StrictIsoDateSchema, reviewer: Text,
  sources: z.array(z.strictObject({ label: Text, url: z.string().url() })).min(1),
});
export type LenderCollateralClassReview = z.output<typeof LenderCollateralClassReviewSchema>;

export const LenderCollateralClassesRegistrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  registryId: z.literal("safety-score-v9.lender-collateral-classes.v1"),
  reviews: z.array(LenderCollateralClassReviewSchema).min(1),
}).superRefine((registry, ctx) => {
  if (!sortedUnique(registry.reviews.map((row) => `${row.chain}:${row.address}`))) {
    fail(ctx, ["reviews"], "Class token keys must be unique and sorted");
  }
});
export type LenderCollateralClassesRegistry = z.output<typeof LenderCollateralClassesRegistrySchema>;
const LenderBookReasonSchema = z.enum([
  "rpc-unavailable", "aborted", "deadline", "unsupported-chain", "unsupported-adapter",
  "unsupported-irm", "identity-mismatch", "block-changed", "incomplete-census", "census-limit",
  "position-not-lender-only", "unreconciled", "zero-nav", "malformed", "stale", "future-dated",
  "missing-observation", "legacy-unobserved", "accepted-source-unavailable", "accepted-source-stale",
  "accepted-source-held", "accepted-card-ineligible", "ambiguous-token", "self-collateral",
  "unmapped-collateral",
]);
export type LenderBookReason = z.output<typeof LenderBookReasonSchema>;
const LenderBookPinSchema = z.strictObject({
  chain: Text, number: Clock, hash: Word, timestampSec: Clock,
  finality: z.literal("finalized"),
});
const LenderMarketObservationSchema = z.strictObject({
  account: Address, adapter: Address.nullable(), morpho: Address, marketId: Word,
  loanToken: Address, collateralToken: Address, oracle: Address, irm: Address, lltvRaw: Raw,
  supplySharesRaw: Raw, positionBorrowSharesRaw: Raw, positionCollateralRaw: Raw,
  marketSupplyAssetsRaw: Raw, marketSupplySharesRaw: Raw,
  marketBorrowAssetsRaw: Raw, marketBorrowSharesRaw: Raw,
  marketLastUpdateSec: Clock, marketFeeRaw: Raw,
  includedAssetsRaw: Raw,
  accruedMethod: z.enum(["adapter-expected-supply-assets", "morpho-blue-expected-balances"]),
  collateralMode: z.enum(["collateralized", "unsecured"]),
}).superRefine((market, ctx) => {
  if (BigInt(market.lltvRaw) > WAD) fail(ctx, ["lltvRaw"], "LLTV must not exceed 1e18");
  if (BigInt(market.marketFeeRaw) > WAD) fail(ctx, ["marketFeeRaw"], "Market fee must not exceed 1e18");
  if (market.positionBorrowSharesRaw !== "0") fail(ctx, ["positionBorrowSharesRaw"], "Position must be lender-only");
  if (market.positionCollateralRaw !== "0") fail(ctx, ["positionCollateralRaw"], "Position must not post collateral");
  const zeroCollateral = market.collateralToken === `0x${"0".repeat(40)}`;
  if (zeroCollateral !== (market.collateralMode === "unsecured")) {
    fail(ctx, ["collateralMode"], "Collateral mode must match the exact market collateral token");
  }
  if (market.collateralMode === "unsecured" && market.lltvRaw !== "0") {
    fail(ctx, ["lltvRaw"], "Unsecured market must have zero LLTV");
  }
});
export type LenderMarketObservation = z.output<typeof LenderMarketObservationSchema>;
const LenderDeploymentObservationSchema = z.strictObject({
  chain: Text, vault: Address, kind: Kind,
  pin: LenderBookPinSchema, loanToken: Address, loanDecimals: z.number().int().min(0).max(36),
  totalAssetsRaw: Raw, totalSupplyRaw: Raw, idleAssetsRaw: Raw,
  realAssetsRaw: Raw.optional(), undistributedAssetsRaw: Raw.optional(),
  reconciledAssetsRaw: Raw, reconciliationResidualRaw: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
  codeHashes: z.record(Text, Word), selectorsRead: z.array(Text),
  markets: z.array(LenderMarketObservationSchema).max(128),
}).superRefine((deployment, ctx) => {
  if (deployment.pin.chain !== deployment.chain) fail(ctx, ["pin", "chain"], "Pin must name the deployment chain");
  if (!sortedUnique(deployment.selectorsRead)) fail(ctx, ["selectorsRead"], "Selectors must be unique and sorted");
  const keys = deployment.markets.map((market) => `${deployment.chain}:${market.morpho}:${market.marketId}:${market.account}`);
  if (!sortedUnique(keys)) fail(ctx, ["markets"], "Market/account identities must be unique and sorted");
  const total = BigInt(deployment.totalAssetsRaw);
  const bookTotal = BigInt(deployment.realAssetsRaw ?? deployment.totalAssetsRaw);
  if (deployment.realAssetsRaw !== undefined || deployment.undistributedAssetsRaw !== undefined) {
    if (deployment.kind !== "vault-v2" || deployment.realAssetsRaw === undefined || deployment.undistributedAssetsRaw === undefined ||
      bookTotal < total || bookTotal - total !== BigInt(deployment.undistributedAssetsRaw ?? "0")) {
      fail(ctx, ["realAssetsRaw"], "VaultV2 real assets and exact undistributed buffer must be supplied together");
    }
  }
  let reconciled = BigInt(deployment.idleAssetsRaw);
  deployment.markets.forEach((market, index) => {
    reconciled += BigInt(market.includedAssetsRaw);
    if (market.loanToken !== deployment.loanToken) fail(ctx, ["markets", index, "loanToken"], "Market loan token must match deployment");
    if (market.marketLastUpdateSec > deployment.pin.timestampSec) fail(ctx, ["markets", index, "marketLastUpdateSec"], "Market state must not postdate its pin");
  });
  if (reconciled !== bookTotal || deployment.reconciledAssetsRaw !== bookTotal.toString() || deployment.reconciliationResidualRaw !== "0") {
    fail(ctx, ["reconciledAssetsRaw"], "Exact measured book reconciliation with zero residual required");
  }
});
export type LenderDeploymentObservation = z.output<typeof LenderDeploymentObservationSchema>;
const ObservationBase = {
  schemaVersion: z.literal(1), assetId: Text, sourceGenerationId: Text,
  acquiredAtSec: Clock, maxAgeSec: z.number().int().positive(), contentSha256: Sha256Schema,
};
export const LenderBookFailedAttemptSchema = z.strictObject({
  ...ObservationBase, status: z.literal("unavailable"), reason: LenderBookReasonSchema,
  failedDeploymentKey: Text.nullable(), deployments: z.null(),
});
export const LenderBookObservationSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...ObservationBase, status: z.literal("ok"),
    censusScope: z.literal("complete-nav-accounted-current-book"),
    deployments: z.array(LenderDeploymentObservationSchema).min(1),
  }),
  LenderBookFailedAttemptSchema,
]).superRefine((observation, ctx) => {
  if (observation.status !== "ok") return;
  if (!sortedUnique(observation.deployments.map((deployment) => `${deployment.chain}:${deployment.vault}`))) {
    fail(ctx, ["deployments"], "Deployment ownership must be unique and sorted");
  }
  const accounts = new Set<string>();
  observation.deployments.forEach((deployment, index) => {
    if (deployment.pin.timestampSec > observation.acquiredAtSec) fail(ctx, ["deployments", index, "pin", "timestampSec"], "Pin must not postdate acquisition");
    for (const market of deployment.markets) {
      const key = `${deployment.chain}:${market.morpho}:${market.marketId}:${market.account}`;
      if (accounts.has(key)) fail(ctx, ["deployments", index, "markets"], "A lender claim must have one deployment owner");
      accounts.add(key);
    }
  });
});
export type LenderBookObservation = z.output<typeof LenderBookObservationSchema>;
const AcceptedCollateralBackingRowSchema = z.strictObject({
  assetId: Text, backingScore: ScoreSchema, cardSha256: Sha256Schema,
  sourceCause: z.enum(["C", "U", "D"]).nullable(), sourceGapIds: z.array(Text),
}).superRefine((row, ctx) => {
  if (!sortedUnique(row.sourceGapIds)) fail(ctx, ["sourceGapIds"], "Source gap IDs must be unique and sorted");
  if ((row.sourceCause === "C" || row.sourceCause === "U") && row.sourceGapIds.length === 0) {
    fail(ctx, ["sourceGapIds"], "Accepted C/U quality requires stable source gap attribution");
  }
});
export const LenderCollateralBackingSchema = z.strictObject({
  schemaVersion: z.literal(1), status: z.enum(["ok", "unavailable"]),
  reason: LenderBookReasonSchema.nullable(),
  publicationGenerationId: Text.nullable(), publishedAtSec: Clock.nullable(),
  policyDigest: Sha256Schema.nullable(), evaluationBuildDigest: Sha256Schema.nullable(),
  registryFingerprint: Sha256Schema, maxAgeSec: z.number().int().positive(),
  tokenToAssetId: z.record(Text, Text),
  byAssetId: z.record(Text, AcceptedCollateralBackingRowSchema),
}).superRefine((bundle, ctx) => {
  const identities = [bundle.publicationGenerationId, bundle.publishedAtSec, bundle.policyDigest, bundle.evaluationBuildDigest];
  if (bundle.status === "ok") {
    if (bundle.reason !== null || identities.some((identity) => identity === null)) fail(ctx, ["status"], "Accepted source must have complete publication identity and no rejection");
  } else if (bundle.reason === null || identities.some((identity) => identity !== null) || Object.keys(bundle.byAssetId).length !== 0) {
    fail(ctx, ["status"], "Unavailable source must have a reason, null publication identity and no score rows");
  }
  const mappedIds = new Set(Object.values(bundle.tokenToAssetId));
  for (const key of Object.keys(bundle.tokenToAssetId)) {
    if (!/^[a-z0-9][a-z0-9._-]*:0x[0-9a-f]{40}$/.test(key)) fail(ctx, ["tokenToAssetId", key], "Exact canonical chain/token key required");
  }
  for (const [key, row] of Object.entries(bundle.byAssetId)) {
    if (key !== row.assetId || !mappedIds.has(key)) fail(ctx, ["byAssetId", key], "Accepted row key must join an exact resolved active ID");
  }
});
export type LenderCollateralBacking = z.output<typeof LenderCollateralBackingSchema>;
export const LenderCollateralResolutionSchema = z.strictObject({
  marketKey: Text, collateralClass: LenderCollateralClassSchema,
  trackedAssetId: Text.nullable(), quality: ScoreSchema,
  qualitySource: z.enum(["previous-accepted-backing", "authored-class", "bounded-unknown"]),
  fallbackReason: LenderBookReasonSchema.nullable(),
  acceptedPublicationGenerationId: Text.nullable(),
  sourceCause: z.enum(["C", "U", "D"]).nullable(), sourceGapIds: z.array(Text),
}).superRefine((resolution, ctx) => {
  if (!sortedUnique(resolution.sourceGapIds)) fail(ctx, ["sourceGapIds"], "Source gap IDs must be unique and sorted");
  if ((resolution.sourceCause === "C" || resolution.sourceCause === "U") && resolution.sourceGapIds.length === 0) {
    fail(ctx, ["sourceGapIds"], "C/U collateral quality requires stable gap attribution");
  }
  if (resolution.qualitySource === "previous-accepted-backing") {
    if (resolution.trackedAssetId === null || resolution.acceptedPublicationGenerationId === null || resolution.fallbackReason !== null) {
      fail(ctx, ["qualitySource"], "Accepted collateral quality requires an exact tracked ID and publication identity");
    }
  } else {
    if (resolution.acceptedPublicationGenerationId !== null || resolution.sourceCause === "D") {
      fail(ctx, ["qualitySource"], "Class fallback must not claim accepted-publication evidence");
    }
    if ((resolution.qualitySource === "bounded-unknown") !== (resolution.collateralClass === "other-unknown")) {
      fail(ctx, ["collateralClass"], "Bounded unknown must use the unknown class");
    }
    if (resolution.qualitySource === "bounded-unknown" && resolution.sourceCause !== "U") {
      fail(ctx, ["sourceCause"], "Unknown collateral class is bounded U, not an adverse finding");
    }
  }
});
export type LenderCollateralResolution = z.output<typeof LenderCollateralResolutionSchema>;

export const LenderCollateralBookPolicySchema = z.strictObject({
  transmissionExponent: z.literal(2), oracleMaterialNavShare: z.literal(0.01),
  observationMaxAgeSec: z.literal(28800), maxAdapters: z.literal(16),
  maxMarketsPerDeployment: z.literal(128), rpcBatchCalls: z.literal(32),
  classQuality: z.record(LenderCollateralClassSchema.exclude(["other-unknown"]), ScoreSchema),
});
export type LenderCollateralBookPolicy = z.output<typeof LenderCollateralBookPolicySchema>;
