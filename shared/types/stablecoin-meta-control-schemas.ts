import { z } from "zod";
import { issue } from "./safety-schema-primitives";
import { V9ControlExecutionScopeSchema, V9WeightedQuorumSchema, V9SameChainSystemTransportSchema, V1005ExecutionClassRefSchema, V1005ExecutionCertificatesSchema, V1005AuthorityGraphSchema, V1005VotingControlSchema, V1005OperationalIssuanceSchema, V9ControlQuestionSubjectSchema } from "./safety-score-v9-control-scope";
import { normalizeDeploymentId } from "./deployment-id";
import { V9AllocationDeploymentIdentitySchema } from "./safety-score-v9-allocation";
import {
  BRIDGE_ROUTE_CLASS_VALUES,
  BRIDGE_ROUTE_CONTROL_CAPABILITY_VALUES,
  BRIDGE_ROUTE_ISSUANCE_MODEL_VALUES,
  BRIDGE_ROUTE_RISK_CONFIDENCE_VALUES,
  BRIDGE_ROUTE_REVIEW_DISPOSITION_VALUES,
  BRIDGE_ROUTE_RISK_SOURCE_VALUES,
  BRIDGE_ROUTE_RISK_TIER_VALUES,
  BRIDGE_ROUTE_SCOPE_VALUES,
  BRIDGE_ROUTE_SEMANTICS_VALUES,
  MINT_AUTHORITY_CONFIDENCE_VALUES,
  MINT_AUTHORITY_CONTROL_ROLE_VALUES,
  MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES,
  MINT_AUTHORITY_ECONOMIC_CAP_SEMANTICS_VALUES,
  MINT_AUTHORITY_KEY_CUSTODY_ATTESTATION_KIND_VALUES,
  MINT_AUTHORITY_MINT_PATH_VALUES,
  MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES,
  MINT_AUTHORITY_NO_LOCAL_ISSUANCE_KIND_VALUES,
  MINT_AUTHORITY_POSTURE_VALUES,
  MINT_AUTHORITY_RECONCILIATION_VALUES,
  MINT_AUTHORITY_SAFE_SOURCE_VALUES,
  MINT_AUTHORITY_SUPERVISION_VALUES,
  MINT_AUTHORITY_TYPE_VALUES,
  MINT_AUTHORITY_UPGRADE_MODEL_VALUES,
  ORACLE_RISK_CONFIDENCE_VALUES,
  ORACLE_RISK_BRANCH_APPLICABILITY_VALUES,
  ORACLE_RISK_BRANCH_MODEL_VALUES,
  ORACLE_RISK_ROLE_VALUES,
  ORACLE_RISK_LIQUIDATION_STATE_VALUES,
  ORACLE_RISK_TIER_VALUES,
} from "./core";
import { hasSourceLinks, hasText, validateMintAuthorityProfile } from "./stablecoin-meta-mint-authority-refinements";
import { HttpUrlSchema } from "./validators";
import {
  DeploymentIdSchema,
  DeploymentRefsSchema,
  PositiveIntegerSchema,
  ReviewDateSchema,
  StablecoinLinkSchema,
} from "./stablecoin-meta-schemas";

// Pure scopes let bundlers omit unused schema graphs, including nested Zod
// constructor arguments; annotating only the outer call leaves those allocated.

export const OracleRiskBranchSchema = /* @__PURE__ */ (() => z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    tier: z.enum(ORACLE_RISK_TIER_VALUES),
    summary: z.string().min(12),
    collateralAssets: z.array(z.string().min(1)).min(1).optional(),
    chains: z.array(z.string().min(1)).min(1).optional(),
    feeds: z
      .array(
        z
          .object({
            provider: z.string().min(1),
            path: z.string().min(1),
            address: z.string().min(1).optional(),
            chain: z.string().min(1),
            heartbeatSec: z.number().finite().int().positive().optional(),
            stalenessBoundSec: z.number().finite().int().positive().optional(),
            observedAt: ReviewDateSchema.optional(),
            observedBlock: z.number().finite().int().nonnegative().optional(),
            failureDomainKeys: z.array(z.string().min(1)).min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    fallbackBehavior: z.string().min(12).optional(),
    observedAt: ReviewDateSchema.optional(),
    observedBlock: z.number().finite().int().nonnegative().optional(),
    collateralParameters: z
      .array(
        z
          .object({
            asset: z.string().min(1),
            maximumLtvPct: z.number().finite().positive().max(100).optional(),
            minimumCollateralRatioPct: z.number().finite().min(100).optional(),
            shutdownCollateralRatioPct: z.number().finite().min(100).optional(),
            note: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    liquidationMechanism: z.string().min(12).optional(),
    /** `uncallable` is distinct from a positive claim of zero-second liquidation. */
    liquidationState: z.enum(ORACLE_RISK_LIQUIDATION_STATE_VALUES).optional(),
    liquidationDelaySec: z.number().finite().int().nonnegative().optional(),
    backstop: z.string().min(12).optional(),
    shutdownOrBadDebtBehavior: z.string().min(12).optional(),
    debtSharePct: z.number().finite().min(0).max(100).optional(),
    failureDomainKeys: z.array(z.string().min(1)).min(1).optional(),
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
  })
  .strict()
  .superRefine((branch, ctx) => {
    for (let index = 0; index < (branch.feeds ?? []).length; index += 1) {
      const feed = branch.feeds![index];
      if (feed.heartbeatSec != null && feed.stalenessBoundSec != null && feed.stalenessBoundSec < feed.heartbeatSec) {
        issue(ctx, ["feeds", index, "stalenessBoundSec"], "oracle feed staleness bound cannot be shorter than its heartbeat");
      }
    }
    if (branch.observedBlock != null && branch.observedAt == null) {
      issue(ctx, ["observedAt"], "observedBlock requires observedAt");
    }
    if (branch.liquidationState === "uncallable" && branch.liquidationDelaySec != null) {
      issue(ctx, ["liquidationDelaySec"], "an uncallable liquidation path cannot claim a liquidation delay");
    }
    if (branch.collateralAssets && branch.collateralParameters) {
      const parameterAssets = new Set(branch.collateralParameters.map((parameter) => parameter.asset));
      for (const asset of branch.collateralAssets) {
        if (parameterAssets.has(asset)) continue;
        issue(ctx, ["collateralParameters"], `missing collateral parameters for ${asset}`);
      }
    }
  }))();

export type OracleRiskBranch = z.infer<typeof OracleRiskBranchSchema>;
// An allocation facilitator is not a borrower market. Identity and the
// reviewed pricing authority keep that exception local to the exact path.
const OracleRiskPathSchema = /* @__PURE__ */ (() => z
  .object({
    id: z.string().min(1),
    chain: z.string().min(1),
    address: z.string().min(1),
    pricingAuthority: z.enum(["external-price", "internal-price", "none", "unknown"]),
    branchId: z.string().min(1).optional(),
    applicability: z
      .object({
        disposition: z.enum(ORACLE_RISK_BRANCH_APPLICABILITY_VALUES),
        reviewedAt: ReviewDateSchema,
        reviewer: z.string().min(1),
        confidence: z.enum(ORACLE_RISK_CONFIDENCE_VALUES),
        rationale: z.string().min(12),
        sources: z.array(StablecoinLinkSchema).min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((path, ctx) => {
    const disposition = path.applicability?.disposition;
    if (disposition === "not-applicable" && (path.pricingAuthority !== "none" || path.branchId != null)) {
      issue(ctx, undefined, "Not-applicable paths cannot have pricing authority or borrower branches");
    }
    if (
      (disposition === "branches-required" || disposition === "top-level-only") &&
      path.pricingAuthority !== "external-price" && path.pricingAuthority !== "internal-price"
    ) {
      issue(ctx, undefined, "Applicable paths require external or internal pricing authority");
    }
    if (disposition === "top-level-only" && path.branchId != null) {
      issue(ctx, undefined, "Top-level pricing paths cannot declare borrower branches");
    }
  }))();


export const OracleRiskProfileSchema = /* @__PURE__ */ (() => z
  .object({
    tier: z.enum(ORACLE_RISK_TIER_VALUES),
    summary: z.string().min(12),
    role: z.enum(ORACLE_RISK_ROLE_VALUES).optional(),
    branchModel: z.enum(ORACLE_RISK_BRANCH_MODEL_VALUES).optional(),
    branchApplicability: z
      .object({
        disposition: z.enum(ORACLE_RISK_BRANCH_APPLICABILITY_VALUES),
        reviewedAt: ReviewDateSchema,
        reviewer: z.string().min(1),
        rationale: z.string().min(12),
        sources: z.array(StablecoinLinkSchema).min(1),
      })
      .strict()
      .optional(),
    reviewedAt: ReviewDateSchema.optional(),
    reviewer: z.string().min(1).optional(),
    confidence: z.enum(ORACLE_RISK_CONFIDENCE_VALUES).optional(),
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
    branches: z.array(OracleRiskBranchSchema).min(1).optional(),
    paths: z.array(OracleRiskPathSchema).min(1).optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.paths) {
      const pathIds = new Set<string>();
      const identities = new Set<string>();
      const referencedBranches = new Set<string>();
      for (const [index, path] of profile.paths.entries()) {
        const identity = `${path.chain}:${path.address.toLowerCase()}`;
        if (pathIds.has(path.id) || identities.has(identity)) {
          issue(ctx, ["paths", index], "Oracle paths require unique ids and deployment identities");
        }
        pathIds.add(path.id);
        identities.add(identity);
        if (path.branchId) referencedBranches.add(path.branchId);
      }
      for (const [index, branch] of (profile.branches ?? []).entries()) {
        if (!referencedBranches.has(branch.id)) {
          issue(ctx, ["branches", index], "Every oracle branch requires an explicit path identity");
        }
      }
    }
    if (profile.branchModel === "multi-branch" && !profile.branches?.length) {
      issue(ctx, ["branches"], "multi-branch oracleRisk profiles require branches");
    }
    // Materiality shares are measured facts; a profile claiming more than the
    // whole debt is self-contradictory (unmeasured branches stay fail-closed,
    // so under-coverage is safe — over-coverage is not).
    const declaredShareTotal = (profile.branches ?? []).reduce(
      (sum, branch) => sum + (branch.debtSharePct ?? 0),
      0,
    );
    if (declaredShareTotal > 100.5) {
      issue(ctx, ["branches"], `oracleRisk branch debtSharePct total ${declaredShareTotal} exceeds 100`);
    }
    if (profile.branchModel === "single-path" && profile.branches?.length) {
      issue(ctx, ["branches"], "single-path oracleRisk profiles cannot declare branches");
    }
    if (profile.branches?.length && profile.branchModel !== "multi-branch") {
      issue(ctx, ["branchModel"], "oracleRisk branches require branchModel multi-branch");
    }
    if (profile.branchApplicability?.disposition === "branches-required" && profile.branchModel !== "multi-branch") {
      issue(ctx, ["branchModel"], "branches-required oracle applicability requires branchModel multi-branch");
    }
    if (profile.branchApplicability?.disposition === "not-applicable" && profile.branchModel === "multi-branch") {
      issue(ctx, ["branchApplicability", "disposition"], "not-applicable oracle applicability cannot declare a multi-branch model");
    }
    if (profile.branchApplicability?.disposition === "top-level-only" && profile.branchModel !== "single-path") {
      issue(ctx, ["branchModel"], "top-level-only oracle applicability requires a single-path model");
    }
  }))();

const BridgeRouteProtocolEvidenceSchema = /* @__PURE__ */ (() => z
  .object({
    source: z.enum(BRIDGE_ROUTE_RISK_SOURCE_VALUES),
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    url: HttpUrlSchema.optional(),
    bridgeTypes: z.array(z.string().min(1)).min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict())();

const BridgeRouteDeploymentSchema = /* @__PURE__ */ (() => z
  .object({
    id: z.string().min(1),
    sourceChain: z.string().min(1).optional(),
    destinationChain: z.string().min(1),
    canonicalChain: z.string().min(1).optional(),
    contractAddress: z.string().min(1),
    representationId: z.string().min(1).optional(),
    protocol: z.string().min(1),
    issuanceModel: z.enum(BRIDGE_ROUTE_ISSUANCE_MODEL_VALUES),
    routeClass: z.enum(BRIDGE_ROUTE_CLASS_VALUES),
    riskTier: z.enum(BRIDGE_ROUTE_RISK_TIER_VALUES),
    semantics: z.enum(BRIDGE_ROUTE_SEMANTICS_VALUES),
    scope: z.enum(BRIDGE_ROUTE_SCOPE_VALUES),
    reviewDisposition: z.enum(BRIDGE_ROUTE_REVIEW_DISPOSITION_VALUES),
    reviewNote: z.string().min(12).optional(),
    mappingVersion: z.string().min(1).optional(),
    controllerChain: z.string().min(1).optional(),
    controllerAddress: z.string().min(1).optional(),
    failureDomainKeys: z.array(z.string().min(1)).min(1).optional(),
    observedAt: ReviewDateSchema.optional(),
    observedBlock: z.number().finite().int().nonnegative().optional(),
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
    deploymentIdentity: V9AllocationDeploymentIdentitySchema.optional(),
  })
  .strict()
  .superRefine((route, ctx) => {
    if ((route.controllerChain == null) !== (route.controllerAddress == null)) {
      issue(ctx, [route.controllerChain == null ? "controllerChain" : "controllerAddress"], "bridge route controllerChain and controllerAddress must be authored together");
    }
    if (route.reviewDisposition === "reviewed") {
      if (!hasSourceLinks(route.sources)) {
        issue(ctx, ["sources"], "reviewed bridge route requires route-level sources");
      }
      if (route.observedAt == null && route.observedBlock == null) {
        issue(ctx, ["observedAt"], "reviewed bridge route requires observedAt or observedBlock");
      }
      if (
        route.scope === "unknown" ||
        route.routeClass === "unknown" ||
        route.issuanceModel === "unknown" ||
        route.semantics === "unknown"
      ) {
        issue(ctx, ["reviewDisposition"], "reviewed bridge route cannot retain unknown classification facts");
      }
    } else {
      if (!hasText(route.reviewNote)) {
        issue(ctx, ["reviewNote"], "unresolved bridge route requires an explicit reviewNote");
      }
      if (
        route.scope !== "unknown" ||
        route.routeClass !== "unknown" ||
        route.issuanceModel !== "unknown" ||
        route.semantics !== "unknown" ||
        route.riskTier !== "opaque-or-unknown"
      ) {
        issue(ctx, ["reviewDisposition"], "unresolved bridge route must keep classification facts unknown");
      }
    }
    if (route.routeClass === "native" && route.issuanceModel !== "native-issuance") {
      issue(ctx, ["issuanceModel"], "native bridge route cannot be labeled as a bridge representation");
    }
  }))();

const NativeInventoryReviewSchema = /* @__PURE__ */ (() => z
  .object({
    kind: z.literal("exhaustive-material-native-census"),
    exhaustive: z.literal(true),
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    routeIds: z.array(z.string().min(1).transform(normalizeDeploymentId)).min(1),
    rationale: z.string().min(12),
    sources: z.array(StablecoinLinkSchema).min(1),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (new Set(review.routeIds).size !== review.routeIds.length) {
      issue(ctx, ["routeIds"], "Native census route identities must be unique");
    }
  }))();

export const BridgeRouteRiskProfileSchema = /* @__PURE__ */ (() => z
  .object({
    tier: z.enum(BRIDGE_ROUTE_RISK_TIER_VALUES),
    summary: z.string().min(12),
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    confidence: z.enum(BRIDGE_ROUTE_RISK_CONFIDENCE_VALUES),
    protocols: z.array(BridgeRouteProtocolEvidenceSchema).min(1).optional(),
    sourceFreeRationale: z.string().min(1).optional(),
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
    routes: z.array(BridgeRouteDeploymentSchema).min(1).optional(),
    nativeInventoryReview: NativeInventoryReviewSchema.optional(),
    controls: z.array(z.lazy(() => BridgeRouteControlSchema)).min(1).optional(),
    scopedQuestions: z.array(z.lazy(() => ControlScopedQuestionSchema)).min(1).optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.nativeInventoryReview) {
      const nativeIds = new Set(profile.nativeInventoryReview.routeIds);
      if (
        nativeIds.size !== (profile.routes?.length ?? 0) ||
        (profile.routes ?? []).some((route) =>
          !nativeIds.has(normalizeDeploymentId(route.id)) ||
          route.reviewDisposition !== "reviewed" ||
          route.routeClass !== "native" ||
          route.issuanceModel !== "native-issuance")
      ) {
        issue(ctx, ["nativeInventoryReview", "routeIds"], "Exhaustive native census must match every reviewed native route, with no representation routes");
      }
    }
    for (const [index, question] of (profile.scopedQuestions ?? []).entries()) {
      const ref = question.controlRef.toLowerCase();
      const matched = (profile.controls ?? []).some(
        (control) =>
          control.id.toLowerCase() === ref ||
          control.label.toLowerCase() === ref ||
          (control.controllerChain != null &&
            control.controllerAddress != null &&
            `${control.controllerChain}:${control.controllerAddress.toLowerCase()}` === ref),
      );
      if (!matched) {
        issue(ctx, ["scopedQuestions", index, "controlRef"], "scoped question controlRef must name a structured bridge control's id, label, or controllerChain:controllerAddress");
      }
    }
    if ((profile.sources?.length ?? 0) > 0 || profile.sourceFreeRationale || (profile.protocols?.length ?? 0) > 0) {
      // Continue validating route identity below.
    } else {
      issue(ctx, ["sources"], "bridgeRouteRisk requires sources, protocols, or sourceFreeRationale");
    }

    const routeIds = new Set<string>();
    for (let index = 0; index < (profile.routes ?? []).length; index += 1) {
      const route = profile.routes![index]!;
      if (routeIds.has(route.id)) {
        issue(ctx, ["routes", index, "id"], `duplicate bridge route id ${route.id}`);
      }
      routeIds.add(route.id);
    }

    const controlIds = new Set<string>();
    for (let index = 0; index < (profile.controls ?? []).length; index += 1) {
      const control = profile.controls![index]!;
      if (controlIds.has(control.id)) {
        issue(ctx, ["controls", index, "id"], `duplicate bridge control id ${control.id}`);
      }
      controlIds.add(control.id);
      if (control.sameChainSystemTransport) {
        const transport = control.sameChainSystemTransport;
        const coreRoute = profile.routes?.find((route) => normalizeDeploymentId(route.id) === `hyperliquid:${transport.coreTokenId}`);
        const evmRoute = profile.routes?.find((route) => normalizeDeploymentId(route.id) === transport.evmToken);
        if (!coreRoute || coreRoute.sourceChain !== "hyperevm" || coreRoute.destinationChain !== "hyperliquid" ||
            coreRoute.riskTier !== "single-chain-or-native" || coreRoute.reviewDisposition !== "reviewed" ||
            !evmRoute || evmRoute.issuanceModel !== "native-issuance") {
          issue(ctx, ["controls", index, "sameChainSystemTransport"], "System transport must join a reviewed same-chain Core route and its native EVM token");
        }
      }
    }
  }))();
const MintAuthoritySafeStateSchema = /* @__PURE__ */ (() => z
  .object({
    version: z.string().min(1).optional(),
    owners: z.array(z.string().min(1)).optional(),
    threshold: PositiveIntegerSchema.optional(),
    enabledModules: z.array(z.string().min(1)).optional(),
    guard: z.string().min(1).nullable().optional(),
    moduleGuard: z.string().min(1).nullable().optional(),
    fallbackHandler: z.string().min(1).nullable().optional(),
    masterCopy: z.string().min(1).nullable().optional(),
    observedBlock: PositiveIntegerSchema.optional(),
    observedAt: ReviewDateSchema.optional(),
    source: z.enum(MINT_AUTHORITY_SAFE_SOURCE_VALUES),
  })
  .strict()
  .superRefine((safe, ctx) => {
    if (safe.threshold != null && safe.owners != null && safe.threshold > safe.owners.length) {
      issue(ctx, ["threshold"], "safe.threshold cannot exceed safe.owners length");
    }
  }))();

const MintAuthorityRouteChecksSchema = /* @__PURE__ */ (() => z
  .object({
    lockboxOrEscrow: z.string().min(1).optional(),
    trustedPeerOrRemote: z.string().min(1).optional(),
    attestorQuorum: z.string().min(1).optional(),
    signingModel: z.string().min(1).optional(),
    rateLimits: z.string().min(1).optional(),
    caps: z.string().min(1).optional(),
    pausersAdminsUpgraders: z.string().min(1).optional(),
    onchainAmountBounds: z.string().min(1).optional(),
    unsupportedReason: z.string().min(1).optional(),
  })
  .strict())();

const MintAuthorityKeyCustodyAttestationSchema = /* @__PURE__ */ (() => z
    .object({
      kind: z.enum(MINT_AUTHORITY_KEY_CUSTODY_ATTESTATION_KIND_VALUES),
      sources: z.array(StablecoinLinkSchema).min(1),
    })
    .strict())();

const MintAuthorityNoLocalIssuanceExceptionSchema = /* @__PURE__ */ (() => z
  .object({
    kind: z.enum(MINT_AUTHORITY_NO_LOCAL_ISSUANCE_KIND_VALUES),
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    rationale: z.string().min(1),
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
  })
  .strict())();

const AuthorityControlFields = {
  label: z.string().min(1),
  authorityType: z.enum(MINT_AUTHORITY_TYPE_VALUES),
  threshold: PositiveIntegerSchema.optional(),
  signerCount: PositiveIntegerSchema.optional(),
  weightedQuorum: V9WeightedQuorumSchema.optional(),
  executionScope: V9ControlExecutionScopeSchema.optional(),
  timelockDelaySec: z.number().finite().int().min(0).optional(),
  safe: MintAuthoritySafeStateSchema.optional(),
  modulesOrGuardsStatus: z.enum(MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES).optional(),
  keyCustodyAttestation: MintAuthorityKeyCustodyAttestationSchema.optional(),
  routeChecks: MintAuthorityRouteChecksSchema.optional(),
  capDescription: z.string().min(1).optional(),
  canRaiseCap: z.union([z.boolean(), z.literal("unknown")]).optional(),
  failureDomainKeys: z.array(z.string().min(1)).min(1).optional(),
  bypassSurfaces: z.array(z.string().min(1)).optional(),
  observedAt: ReviewDateSchema.optional(),
  observedBlock: PositiveIntegerSchema.optional(),
  sources: z.array(StablecoinLinkSchema).min(1).optional(),
  evidence: z.string().min(12).optional(),
};

function validateExactAuthority(control: z.output<z.ZodObject<typeof AuthorityControlFields>>, chain: string | undefined, address: string | undefined, ctx: z.RefinementCtx, domain: "mint" | "bridge"): void {
  if (control.threshold != null && control.signerCount != null && control.threshold > control.signerCount) {
    issue(ctx, ["threshold"], "threshold cannot exceed signerCount");
  }

  // Bridge reviews may describe a Safe as a multisig or record it upstream of a timelock.
  if (control.safe != null && control.authorityType !== "safe" &&
      !(domain === "bridge" && (control.authorityType === "timelock" || control.authorityType === "multisig"))) {
    issue(ctx, ["safe"], "safe details require a Safe authority or a bridge multisig/Safe-governed timelock");
  }

  if (control.safe?.threshold != null && control.threshold != null && control.safe.threshold !== control.threshold) {
    issue(ctx, ["safe", "threshold"], "safe.threshold must match threshold when both are present");
  }

  if (
    control.safe?.owners != null &&
    control.signerCount != null &&
    control.safe.owners.length !== control.signerCount
  ) {
    issue(ctx, ["safe", "owners"], "safe.owners length must match signerCount when both are present");
  }
  const deployment = chain && address ? normalizeDeploymentId(`${chain}:${address}`) : null;
  if (control.weightedQuorum && (control.threshold != null || control.signerCount != null || control.authorityType !== "multisig")) {
    issue(ctx, ["weightedQuorum"], "Weighted multisig excludes uniform threshold and signerCount");
  }
  if (control.weightedQuorum && deployment !== control.weightedQuorum.deployment) {
    issue(ctx, ["weightedQuorum"], "Weighted quorum must match exact controller deployment");
  }
  if (control.executionScope && deployment !== control.executionScope.controllerDeployment) {
    issue(ctx, ["executionScope"], "Execution scope must match exact controller deployment");
  }
  if (control.executionScope && control.safe?.observedBlock != null && String(control.safe.observedBlock) !== control.executionScope.pin.position) {
    issue(ctx, ["executionScope"], "Safe and execution scope must share observation pin");
  }
  for (const path of control.executionScope?.paths ?? []) {
    if (path.downstreamCallDomain && control.timelockDelaySec != null &&
        path.downstreamCallDomain.minimumDelaySec > control.timelockDelaySec) {
      issue(ctx, ["executionScope"], "Maximal execution cannot claim more delay than the controller's fastest enforced path");
    }
    if (path.activation === "counterfactual" && path.counterfactual &&
        (control.authorityType !== "safe" && control.authorityType !== "multisig" ||
          control.weightedQuorum != null || control.threshold !== path.counterfactual.threshold ||
          control.signerCount !== path.counterfactual.owners.length)) {
      issue(ctx, ["executionScope"], "Counterfactual initialized quorum must match the exact uniform authority");
    }
  }
  if (control.weightedQuorum && control.executionScope &&
      (control.weightedQuorum.pin.runtimeIdentity !== control.executionScope.pin.runtimeIdentity ||
        control.weightedQuorum.pin.signerIdentity !== control.executionScope.pin.signerIdentity)) {
    issue(ctx, ["executionScope"], "Weighted signing and execution certificates must bind the same identities");
  }
}

const BridgeRouteControlSchema = /* @__PURE__ */ (() => z
  .object({
    // Kebab-case without a nested quantifier: `^[a-z0-9]+(?:-[a-z0-9]+)*$` accepts
    // the same ids but trips security/detect-unsafe-regex. The character-class
    // match plus explicit boundary checks are linear in the input length.
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/, "Expected a kebab-case bridge control id")
      .refine((value) => !value.startsWith("-") && !value.endsWith("-") && !value.includes("--"), {
        message: "Expected a kebab-case bridge control id",
      }),
    routeRefs: z.array(DeploymentIdSchema).min(1),
    capabilities: z
      .array(z.enum(BRIDGE_ROUTE_CONTROL_CAPABILITY_VALUES))
      .min(1)
      .refine((capabilities) => new Set(capabilities).size === capabilities.length, {
        message: "bridge control capabilities must be unique",
      }),
    controllerChain: z.string().min(1).optional(),
    controllerAddress: z.string().min(1).optional(),
    ...AuthorityControlFields,
    sameChainSystemTransport: V9SameChainSystemTransportSchema.optional(),
  })
  .strict()
  .superRefine((control, ctx) => {
    validateExactAuthority(control, control.controllerChain, control.controllerAddress, ctx, "bridge");
    const transport = control.sameChainSystemTransport;
    if ((control.authorityType === "chain-consensus") !== (transport != null)) {
      issue(ctx, undefined, "Chain consensus authority requires the typed same-chain transport family");
    }
    if (transport) {
      if (control.controllerChain !== "hyperevm" || control.controllerAddress?.toLowerCase() !== transport.systemAddress ||
          control.routeRefs.length !== 1 || normalizeDeploymentId(control.routeRefs[0]!) !== `hyperliquid:${transport.coreTokenId}`) {
        issue(ctx, undefined, "System transport must bind the exact system controller and Core token route");
      }
      if (control.capabilities.length !== 1 || control.capabilities[0] !== "escrow" ||
          control.threshold != null || control.signerCount != null || control.weightedQuorum != null || control.safe != null ||
          control.keyCustodyAttestation != null || control.executionScope != null || control.canRaiseCap != null) {
        issue(ctx, undefined, "Spot system transport is escrow transfer, not privileged minting or an independent signing quorum");
      }
      if (!control.sources?.length || !control.evidence || !control.observedAt || control.observedBlock == null) {
        issue(ctx, undefined, "System transport requires sourced, dated and pinned asset-link evidence");
      }
    }
  }))();

const ControlScopedQuestionSchema = /* @__PURE__ */ (() => z
  .object({
    controlRef: z.string().min(1),
    question: z.string().min(12),
    subject: V9ControlQuestionSubjectSchema.optional(),
    reviewedAt: ReviewDateSchema,
    reviewer: z.string().min(1),
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
  })
  .strict())();

const MintAuthorityControlSchema = /* @__PURE__ */ (() => z
  .object({
    chain: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    deploymentRefs: DeploymentRefsSchema.optional(),
    controllerAssetId: z.string().min(1).optional(),
    role: z.enum(MINT_AUTHORITY_CONTROL_ROLE_VALUES),
    directMintAbility: z.enum(MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES),
    ...AuthorityControlFields,
    executionClassRef: V1005ExecutionClassRefSchema.optional(),
  })
  .strict()
  .superRefine((control, ctx) => {
    validateExactAuthority(control, control.chain, control.address, ctx, "mint");
    if (control.authorityType === "chain-consensus") issue(ctx, undefined, "Same-chain transport belongs to route controls, not native mint authority");
    if (control.executionScope && control.executionClassRef) issue(ctx, ["executionClassRef"], "Individual scope and class reference are mutually exclusive");
    if (control.executionClassRef && normalizeDeploymentId(`${control.chain ?? ""}:${control.address ?? ""}`) !== control.executionClassRef.memberRef) issue(ctx, ["executionClassRef", "memberRef"], "Execution class must bind the exact controller");
  }))();

const MintAuthorityReviewSchema = /* @__PURE__ */ (() => z
  .object({
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
    sourceFreeRationale: z.string().min(1).optional(),
    evidence: z.string().min(24),
    reviewer: z.string().min(1),
    reviewedAt: ReviewDateSchema,
    disposition: z.enum(["scoreable", "unresolved"]).optional(),
    unresolvedQuestions: z.array(z.string().min(1)).optional(),
    scopedQuestions: z.array(ControlScopedQuestionSchema).min(1).optional(),
    noLocalIssuance: MintAuthorityNoLocalIssuanceExceptionSchema.optional(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (hasSourceLinks(review.sources) || review.sourceFreeRationale) {
      // Continue validating the explicit unresolved disposition below.
    } else {
      issue(ctx, ["sources"], "mintAuthority.review requires sources or sourceFreeRationale");
    }
    if (review.disposition === "unresolved" && (review.unresolvedQuestions?.length ?? 0) === 0) {
      issue(ctx, ["unresolvedQuestions"], "unresolved mint-authority disposition requires unresolvedQuestions");
    }
  }))();

const MintAuthorityIncidentSchema = /* @__PURE__ */ (() => z
  .object({
    date: ReviewDateSchema,
    status: z.enum(["active", "resolved"]),
    resolvedAt: ReviewDateSchema.optional(),
    summary: z.string().min(12),
    sources: z.array(StablecoinLinkSchema).min(1),
  })
  .strict()
  .superRefine((incident, ctx) => {
    if (incident.status === "active" && incident.resolvedAt != null) {
      issue(ctx, ["resolvedAt"], "active mint incidents cannot carry resolvedAt");
    }
    if (incident.resolvedAt != null && incident.resolvedAt < incident.date) {
      issue(ctx, ["resolvedAt"], "mint incident resolvedAt cannot precede its incident date");
    }
  }))();

const MintAuthorityProfileObjectSchema = /* @__PURE__ */ (() => z
  .object({
    mintPath: z.enum(MINT_AUTHORITY_MINT_PATH_VALUES),
    authorityPosture: z.enum(MINT_AUTHORITY_POSTURE_VALUES),
    confidence: z.enum(MINT_AUTHORITY_CONFIDENCE_VALUES),
    summary: z.string().min(12),
    /**
     * Authored summary-layer verdict for the detail card (≤25 words, no raw
     * identifiers); the word/identifier budget is enforced in
     * `shared/lib/stablecoins/schema.ts`, which may import `shared/lib/summary-budget`.
     */
    headline: z.string().trim().min(1).optional(),
    inheritedFrom: z.string().min(1).optional(),
    upgradeability: z
      .object({
        model: z.enum(MINT_AUTHORITY_UPGRADE_MODEL_VALUES),
        deploymentRefs: DeploymentRefsSchema.optional(),
        proxyAddresses: z.array(z.string().min(1)).min(1).optional(),
        implementationAddresses: z.array(z.string().min(1)).min(1).optional(),
        adminAddresses: z.array(z.string().min(1)).min(1).optional(),
        canChangeMintLogic: z.union([z.boolean(), z.literal("unknown")]),
        delaySec: z.number().finite().int().nonnegative().optional(),
        controlRef: z.string().min(1).optional(),
        observedAt: ReviewDateSchema.optional(),
        observedBlock: PositiveIntegerSchema.optional(),
        sources: z.array(StablecoinLinkSchema).min(1),
      })
      .strict()
      .optional(),
    mintIncidents: z.array(MintAuthorityIncidentSchema).min(1).optional(),
    controls: z.array(MintAuthorityControlSchema).optional(),
    economicCapSemantics: z.enum(MINT_AUTHORITY_ECONOMIC_CAP_SEMANTICS_VALUES).optional(),
    executionCertificates: V1005ExecutionCertificatesSchema.optional(),
    authorityGraph: V1005AuthorityGraphSchema.optional(),
    operationalIssuance: V1005OperationalIssuanceSchema.optional(),
    governedIssuance: z
      .object({
        decisionRule: z.enum(["affirmative-vote", "minority-veto"]),
        governorControlRef: z.string().regex(/^[a-z0-9][a-z0-9-]*:0x[0-9a-f]{40}$/, "Expected a chain:lowercase EVM address governor reference"),
        votingPower: z.enum(["holding-period-weighted", "lock-escrowed", "past-block-checkpoint", "live-balance", "unknown"]),
        votingPowerEvidence: z.string().trim().min(40),
        votingControl: V1005VotingControlSchema,
        veto: z
          .object({
            quorumBps: z.number().int().min(1).max(10000),
            entrypoints: z.array(z.string().regex(/^0x[0-9a-f]{8}$/)).min(1),
            override: z.enum(["none", "symmetric-vote-destruction", "insolvency-gated-restructure", "unknown"]),
            restructure: z
              .object({
                entrypoints: z.array(z.string().regex(/^0x[0-9a-f]{8}$/)).min(1),
                equityThresholdUnits: z.number().finite().positive(),
                observedEquityUnits: z.number().finite().nonnegative(),
                dependentPaths: z.array(z.object({
                  controlRef: z.string().regex(/^[a-z0-9][a-z0-9-]*:0x[0-9a-f]{40}$/),
                  pathId: z.string().min(1),
                }).strict()),
                evidence: z.string().trim().min(80),
              })
              .strict()
              .optional(),
            evidence: z.string().trim().min(80),
          })
          .strict()
          .superRefine((veto, ctx) => {
            if ((veto.override === "insolvency-gated-restructure") !== (veto.restructure !== undefined)) {
              issue(ctx, ["restructure"], "restructure must be present if and only if override is insolvency-gated-restructure");
            }
          })
          .optional(),
        monetaryPolicyPaths: z.array(z.object({
          controlRef: z.string().regex(/^[a-z0-9][a-z0-9-]*:0x[0-9a-f]{40}$/),
          pathId: z.string().min(1),
          rateCapPpm: z.number().int().positive(),
          rateChangeDelaySec: z.number().int().nonnegative(),
          rateChangeRule: z.enum(["minority-replaceable", "unrestricted", "unknown"]),
          evidence: z.string().trim().min(80),
        }).strict()).optional(),
        enumerability: z
          .object({
            authorizationEvents: z.array(z.string().min(1)).min(1),
            capacityReads: z.array(z.string().min(1)).min(1),
          })
          .strict(),
        observedAt: ReviewDateSchema,
        observedBlock: PositiveIntegerSchema,
        reviewedAt: ReviewDateSchema,
        reviewer: z.string().min(1),
        sources: z.array(StablecoinLinkSchema).min(1),
      })
      .strict()
      .optional(),
    capSemanticsReview: z
      .object({
        verdict: z.enum(["bounded-by-construction", "raiseable-collateral-only"]),
        rationale: z.string().trim().min(80),
        reviewedAt: ReviewDateSchema,
        reviewer: z.string().min(1),
        sources: z.array(StablecoinLinkSchema).min(1),
      })
      .strict()
      .optional(),
    reconciliation: z.enum(MINT_AUTHORITY_RECONCILIATION_VALUES).optional(),
    supervision: z.enum(MINT_AUTHORITY_SUPERVISION_VALUES).optional(),
    review: MintAuthorityReviewSchema,
  })
  .strict())();

// Keep the inferred object type independent of the refinement's profile type.
export const MintAuthorityProfileSchema = /* @__PURE__ */ ((): typeof MintAuthorityProfileObjectSchema =>
  MintAuthorityProfileObjectSchema.superRefine(validateMintAuthorityProfile))();

export type OracleRiskProfile = z.output<typeof OracleRiskProfileSchema>;
export type OracleRiskBranchApplicabilityReview = NonNullable<OracleRiskProfile["branchApplicability"]>;
export type OracleRiskFeed = NonNullable<OracleRiskBranch["feeds"]>[number];
export type OracleRiskCollateralParameter = NonNullable<OracleRiskBranch["collateralParameters"]>[number];
export type BridgeRouteProtocolEvidence = z.output<typeof BridgeRouteProtocolEvidenceSchema>;
export type BridgeRouteDeployment = z.output<typeof BridgeRouteDeploymentSchema>;
export type BridgeRouteRiskProfile = z.output<typeof BridgeRouteRiskProfileSchema>;
export type BridgeRouteControl = NonNullable<BridgeRouteRiskProfile["controls"]>[number];
export type BridgeRouteScopedQuestion = NonNullable<BridgeRouteRiskProfile["scopedQuestions"]>[number];
export type MintAuthoritySafeState = z.output<typeof MintAuthoritySafeStateSchema>;
export type MintAuthorityRouteChecks = z.output<typeof MintAuthorityRouteChecksSchema>;
export type MintAuthorityKeyCustodyAttestation = z.output<typeof MintAuthorityKeyCustodyAttestationSchema>;
export type MintAuthorityNoLocalIssuanceException = z.output<typeof MintAuthorityNoLocalIssuanceExceptionSchema>;
export type MintAuthorityControl = z.output<typeof MintAuthorityControlSchema>;
export type MintAuthorityScopedQuestion = z.output<typeof ControlScopedQuestionSchema>;
export type MintAuthorityReview = z.output<typeof MintAuthorityReviewSchema>;
export type MintAuthorityProfile = z.output<typeof MintAuthorityProfileSchema>;
export type MintAuthorityUpgradeability = NonNullable<MintAuthorityProfile["upgradeability"]>;
