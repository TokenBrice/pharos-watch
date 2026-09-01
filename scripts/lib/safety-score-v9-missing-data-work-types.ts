import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import type { V9EvidenceGapQueueEntryV2 } from "@shared/types/safety-score-v9-evidence-queue";
import type { StablecoinSourceEntry } from "./stablecoin-catalog-sources";

export type WorkType =
  | "ACCESS_REVIEW"
  | "ARCHETYPE_CLASSIFICATION"
  | "BRIDGE_MATERIALITY"
  | "BRIDGE_ROUTE_REVIEW"
  | "CHAIN_SUPPLY"
  | "DEPENDENCY_REVIEW"
  | "DEPLOYMENT_CONTROLS"
  | "EXIT_DEX_COVERAGE"
  | "EXIT_OUTPUT"
  | "EXIT_RUNTIME_ROUTE"
  | "EXIT_SETTLEMENT_BOUND"
  | "IMPLEMENTATION_DATE"
  | "MECHANISM_REVIEW"
  | "MINT_AUTHORITY"
  | "ORACLE_BRANCH"
  | "ORACLE_PROFILE"
  | "PARENT_RATEABILITY"
  | "PEG_INPUT"
  | "RESERVE_COMPOSITION"
  | "RESERVE_SLICE";

export type ResolutionMode =
  | "agent-curation"
  | "issuer-or-onchain-evidence"
  | "methodology-capability"
  | "mixed-curation-and-runtime"
  | "producer-runtime";

export interface WorkTypeDefinition {
  title: string;
  stream: string;
  instructions: string;
  completionCriteria: string;
  recommendedSkill: string | null;
  likelyRepoAreas: string[];
  cautions: string[];
}

type Source = Pick<StablecoinSourceEntry, "file" | "sidecarFiles">;

export interface WorkTypeDescriptor extends WorkTypeDefinition {
  ownerDomain: string;
  defaultResolutionMode: ResolutionMode;
  reasonCodes: readonly string[];
  context(asset: V9AssetFactsV3): unknown;
  touchpoints(source: Source, context: unknown): readonly string[];
}

function routeSummary(route: V9AssetFactsV3["exitRoutes"][number]) {
  return {
    routeKey: route.routeKey,
    routeId: route.routeId,
    lane: route.lane,
    routeFamily: route.routeFamily,
    status: route.status,
    evidenceKind: route.evidenceKind,
    coverageClass: route.coverageClass,
    scoreEligible: route.scoreEligible,
    output: route.output,
  };
}

function sidecarFor(source: Source, domain: string): string | null {
  return source.sidecarFiles?.find((path) => path.includes(`/domains/${domain}/`)) ?? null;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

const base = (source: Source) => source.file;
const risk = (source: Source) => sidecarFor(source, "risk-review") ?? source.file;
const reserve = (source: Source) => sidecarFor(source, "reserves") ?? source.file;
const mint = (source: Source) => sidecarFor(source, "mint-authority") ?? source.file;
const exitContext = (asset: V9AssetFactsV3) => ({
  exitStatus: asset.exitStatus,
  routes: asset.exitRoutes.map(routeSummary),
});

export const V9_MISSING_DATA_WORK_TYPES: Readonly<Record<WorkType, WorkTypeDescriptor>> = {
  ACCESS_REVIEW: {
    title: "Transfer and freeze access review", stream: "CTRL",
    instructions: "Research the current transfer-restriction and freeze/blacklist posture, including reach, controlling authority, inherited upstream exposure, and failure-domain identity. Add a dated, sourced blacklistabilityReview in the risk-review sidecar or base coin record.",
    completionCriteria: "A fresh exact replay reports known transfer and freeze access facts and the listed access gapId is absent.",
    recommendedSkill: "stablecoin-info-fetch", likelyRepoAreas: ["shared/data/stablecoins/domains/risk-review/", "shared/data/stablecoins/coins/"],
    cautions: ["Review every material deployment and inherited wrapper exposure; a token-level boolean alone is insufficient."],
    ownerDomain: "control", defaultResolutionMode: "agent-curation",
    reasonCodes: [
      "missing-access-review",
      "inherited-access-exposure",
      "reviewed-possible-access",
    ],
    context: (asset) => asset.accessReview,
    touchpoints: (source) => unique([risk(source)]),
  },
  ARCHETYPE_CLASSIFICATION: {
    title: "Mechanism archetype classification", stream: "ARCH",
    instructions: "Assign the mechanismArchetype that matches the live stabilization and claim structure, with a sourced mechanismArchetypeReview. Record an intentional parent divergence with archetypeOverride when applicable.",
    completionCriteria: "A fresh exact replay resolves the archetype and removes the missing-archetype gapId.",
    recommendedSkill: "resilience-classify", likelyRepoAreas: ["shared/data/stablecoins/coins/"], cautions: ["Classification clears NR eligibility but does not assert that the mechanism is safe."],
    ownerDomain: "methodology",
    defaultResolutionMode: "agent-curation",
    reasonCodes: [
      "missing-archetype",
      "insufficient-evidence",
      "missing-pillar",
    ],
    context: (asset) => ({
      archetype: asset.archetype,
      mechanismRiskReview: asset.mechanismRiskReview,
    }),
    touchpoints: (source) => [base(source)],
  },
  BRIDGE_MATERIALITY: {
    title: "Bridge deployment materiality", stream: "BRDG",
    instructions: "Reconcile current chain-level circulating USD to reviewed deployment routes so selected, unknown, and unreviewed bridge supply shares are explicit. This usually needs both complete route metadata and a fresh chain-supply producer capture.",
    completionCriteria: "A fresh exact replay has current bridge supply shares and removes the runtime-bridge-materiality-unavailable gapId.", recommendedSkill: "contract-enrich",
    likelyRepoAreas: ["shared/data/stablecoins/domains/risk-review/", "shared/data/stablecoins/coins/", "worker/src/lib/safety-score-v9-extension-supply.ts", "worker/src/cron/snapshot-chain-supply.ts"],
    cautions: ["Do not add a manual supply override or multiply DefiLlama list-endpoint circulating USD by price."], ownerDomain: "control", defaultResolutionMode: "mixed-curation-and-runtime",
    reasonCodes: [
      "runtime-bridge-materiality-unavailable",
      "material-bridge-supply-unmatched",
      "nonmaterial-bridge-supply-unmatched",
    ],
    context: (asset) => ({
      supply: asset.supply,
      bridge: asset.economicControlReview.bridge,
      controls: asset.controls,
    }),
    touchpoints: (source) =>
      unique([risk(source), base(source), "worker/src/lib/safety-score-v9-extension-supply.ts"]),
  },
  BRIDGE_ROUTE_REVIEW: {
    title: "Bridge route control review", stream: "BRDG",
    instructions: "Populate the material bridgeRouteRisk route rows with route identity, scope, issuance model, verification/control model, risk tier, sources, reviewer, and review date. Explicitly rule native-only deployments not applicable when supported.",
    completionCriteria: "A fresh exact replay resolves the bridge economic-control review and removes the listed bridge gapId.", recommendedSkill: "stablecoin-info-fetch",
    likelyRepoAreas: ["shared/data/stablecoins/domains/risk-review/", "shared/data/stablecoins/coins/"], cautions: ["Only reviewed, runtime-selected material routes should influence the score."],
    ownerDomain: "control",
    defaultResolutionMode: "agent-curation",
    reasonCodes: [
      "missing-bridge-routes",
      "missing-bridge-route-rows",
      "missing-bridge-route",
      "selected-bridge-route-missing",
      "selected-bridge-route-unresolved",
    ],
    context: (asset) => ({
      bridge: asset.economicControlReview.bridge,
      controls: asset.controls,
    }),
    touchpoints: (source) => unique([risk(source)]),
  },
  CHAIN_SUPPLY: {
    title: "Current chain supply evidence", stream: "SUPPLY",
    instructions: "Restore a current, score-eligible circulating-USD observation for the asset. Verify provider identity, price path, contracts, and chain coverage; enrich missing deployments or repair producer mapping when needed.",
    completionCriteria: "The exact fixed input contains current chain supply, the compiled supply status is known, and the chain-supply gapId is absent.", recommendedSkill: "stablecoin-runtime-price-marketcap-gate",
    likelyRepoAreas: ["shared/data/stablecoins/coins/", "worker/src/cron/sync-stablecoins.ts", "worker/src/cron/snapshot-chain-supply.ts", "worker/src/lib/safety-score-v9-extension-supply.ts"],
    cautions: ["Use getCirculatingRaw(); DefiLlama list circulating values are already USD-denominated.", "Do not add manual, on-chain, CMC, DEX, or other supply overrides."],
    ownerDomain: "evidence",
    defaultResolutionMode: "mixed-curation-and-runtime",
    reasonCodes: [],
    context: (asset) => asset.supply,
    touchpoints: (source) =>
      unique([
        base(source),
        "worker/src/cron/snapshot-chain-supply.ts",
        "worker/src/lib/safety-score-v9-extension-supply.ts",
      ]),
  },
  DEPENDENCY_REVIEW: {
    title: "Effective dependency relationship review", stream: "DEP",
    instructions: "Review the complete effective dependency set. Map proportional collateral exposures to exact upstream asset IDs and weights, and record wrapper/mechanism dependencies as explicit serial edges with dated evidence.",
    completionCriteria: "The compiled dependency graph is valid and known, and a fresh exact replay removes the dependency gapId.", recommendedSkill: "reserve-research",
    likelyRepoAreas: ["shared/data/stablecoins/domains/reserves/", "shared/data/stablecoins/coins/"], cautions: ["Do not create a dependency merely because two assets share an issuer, chain, custodian, or trading pair."],
    ownerDomain: "dependency",
    defaultResolutionMode: "agent-curation",
    reasonCodes: [
      "unreviewed-dependency-relationships",
      "material-dependency-unavailable",
      "nonmaterial-dependency-unavailable",
    ],
    context: (asset) => asset.dependencies,
    touchpoints: (source) => unique([reserve(source), base(source)]),
  },
  DEPLOYMENT_CONTROLS: {
    title: "Deployment control identity and upgrade review", stream: "CTRL",
    instructions: "Resolve every material deployment control: authority identity/model and threshold, capabilities, cap semantics, delay, incident state, material share, claim-impairment scope, economic-loss scope, and failure domains. Complete the upgrade posture and controlRef links.",
    completionCriteria: "All required deployment controls compile as known and the listed control or upgradeability gapId is absent from a fresh exact replay.", recommendedSkill: null,
    likelyRepoAreas: ["shared/data/stablecoins/domains/mint-authority/", "shared/data/stablecoins/domains/risk-review/", "shared/data/stablecoins/coins/"], cautions: ["Multichain assets require the authority graph for every material deployment."],
    ownerDomain: "control",
    defaultResolutionMode: "agent-curation",
    reasonCodes: [
      "missing-upgradeability-review",
      "scoped-control-question",
      "unresolved-control-identity",
      "missing-upgrade-control",
      "unknown-control-cap-authority",
      "unknown-upgrade-authority",
    ],
    context: (asset) => ({
      controlStatus: asset.controlStatus,
      controls: asset.controls,
      economicControlReview: asset.economicControlReview,
    }),
    touchpoints: (source) => unique([mint(source), risk(source)]),
  },
  EXIT_DEX_COVERAGE: {
    title: "Exact DEX route coverage", stream: "EXIT",
    instructions: "Make every retained material DEX pool carry a score-eligible exact route observation: supported pool math, explicit output valuation, request/capacity curve, settlement facts, resource identity, and failure domains. Unsupported pool archetypes require producer capability, not a hand-entered estimate.",
    completionCriteria: "A fresh exact capture marks the retained DEX portfolio exact-complete and removes the incomplete-dex-route-coverage gapId.", recommendedSkill: null,
    likelyRepoAreas: ["worker/src/cron/dex-liquidity/", "worker/src/lib/dex-liquidity.ts", "worker/src/lib/safety-score-v9-extension.ts", "shared/lib/dex-liquidity-evidence.ts"], cautions: ["Do not substitute TVL, generic liquidity, or a manually estimated capacity curve for exact executable depth."],
    ownerDomain: "exit",
    defaultResolutionMode: "producer-runtime",
    reasonCodes: [
      "incomplete-dex-route-coverage",
      "unsupported-same-notional-route",
    ],
    context: exitContext,
    touchpoints: () => ["worker/src/cron/dex-liquidity/", "worker/src/lib/safety-score-v9-extension.ts"],
  },
  EXIT_OUTPUT: {
    title: "Exit route output valuation", stream: "EXIT",
    instructions: "Identify the actual asset or basket delivered by the route and provide same-notional USD valuation. For documented redemption rails, add outputAssets to the matching redemption config; for DEX routes, repair producer token/output resolution.",
    completionCriteria: "The route output is explicit and valued in a fresh exact capture, and the route-specific unresolved-exit-output gapId is absent.", recommendedSkill: null,
    likelyRepoAreas: ["shared/lib/redemption-backstop-configs/", "worker/src/lib/safety-score-v9-extension.ts"], cautions: ["Only name an output that the route documentation or on-chain execution actually establishes."],
    ownerDomain: "exit",
    defaultResolutionMode: "agent-curation",
    reasonCodes: ["unresolved-exit-output"],
    context: exitContext,
    touchpoints: (_source, context) =>
      typeof context === "object" && context !== null && "lane" in context && context.lane === "dex"
        ? ["worker/src/lib/safety-score-v9-extension.ts"]
        : ["shared/lib/redemption-backstop-configs/"],
  },
  EXIT_RUNTIME_ROUTE: {
    title: "Runtime exit route evidence", stream: "EXIT",
    instructions: "Produce at least one current exact DEX, redemption, or retained route observation with comparable notional, capacity, cost, access, settlement, output valuation, and failure-domain evidence.",
    completionCriteria: "The exact fixed input contains a score-eligible route and a fresh replay removes the missing-runtime-route-evidence gapId.", recommendedSkill: null,
    likelyRepoAreas: ["worker/src/cron/dex-liquidity/", "worker/src/cron/sync-redemption-backstops.ts", "worker/src/lib/redemption-exit-route-observations.ts", "worker/src/lib/safety-score-v9-extension.ts"], cautions: ["A source-only metadata edit is not complete until a fresh producer capture embeds the observation."],
    ownerDomain: "exit",
    defaultResolutionMode: "producer-runtime",
    reasonCodes: [
      "missing-runtime-route-evidence",
      "incomparable-route-requests",
      "missing-same-notional-route",
    ],
    context: exitContext,
    touchpoints: () => ["worker/src/cron/dex-liquidity/", "worker/src/cron/sync-redemption-backstops.ts", "worker/src/lib/safety-score-v9-extension.ts"],
  },
  EXIT_SETTLEMENT_BOUND: {
    title: "Exit route settlement-bound proof", stream: "EXIT",
    instructions: "Resolve the flagged route's settlement bound: obtain or document a contract-verified or issuer-published bound proving completion within the same-notional settlement horizon (e.g. a redemption SLA), or, when the rail is genuinely an operator-batched queue with no bound, record that disposition in the redemption-backstop config rather than leaving the route silently excluded. Do not synthesize a capacity curve or settlement bound that the rail does not actually prove.",
    completionCriteria: "A fresh exact replay resolves the route's settlement bound as proven, or confirms the route is no longer score-eligible, and the unproven-settlement-bound gapId is absent.",
    recommendedSkill: null, likelyRepoAreas: ["shared/lib/redemption-backstop-configs/", "worker/src/cron/reserve-adapters/"],
    cautions: ["A measured-adverse pause is a different fact from an unproven bound; do not conflate the two or invent a bound the rail does not document."],
    ownerDomain: "exit",
    defaultResolutionMode: "agent-curation",
    reasonCodes: ["unproven-settlement-bound"],
    context: exitContext,
    touchpoints: () => ["shared/lib/redemption-backstop-configs/"],
  },
  IMPLEMENTATION_DATE: {
    title: "Current mechanism implementation date", stream: "EVID",
    instructions: "Research the launch date of the currently scored mechanism boundary and populate implementationLaunchDate. Use the conservative range end for fuzzy dates and cite the source in the surrounding reviewed metadata or batch report.",
    completionCriteria: "The compiled launchedAtSec is known and a fresh exact replay removes the missing-implementation-date gapId.", recommendedSkill: "stablecoin-info-fetch", likelyRepoAreas: ["shared/data/stablecoins/coins/"], cautions: ["Do not use an earlier predecessor launch if the current mechanism was materially replaced."],
    ownerDomain: "evidence",
    defaultResolutionMode: "agent-curation",
    reasonCodes: ["missing-implementation-date"],
    context: (asset) => asset.implementation,
    touchpoints: (source) => [base(source)],
  },
  MECHANISM_REVIEW: {
    title: "Mechanism risk component review", stream: "MECH",
    instructions: "Curate source-backed facts for the exact mechanism component in the mechanism-review overlay. Fiat-cash, T-bill, and commodity-claim components must satisfy the ratified strict evidence standard; when disclosure is insufficient, record a sourced unavailable disposition that remains bounded and non-scoring. Advanced archetypes require the complete measured-metric overlay.",
    completionCriteria: "A fresh exact replay either compiles the exact component as known and removes its bounded-mechanism-review gapId, or confirms that an independently reviewed unavailable disposition retains the bounded-unknown gap without changing score or grade.", recommendedSkill: "reserve-research",
    likelyRepoAreas: ["shared/data/safety-score-v9/mechanism-review-overlays-v1.json", "shared/data/stablecoins/domains/reserves/", "shared/data/stablecoins/coins/", "worker/src/lib/safety-score-v9-extension-mechanism.ts"], cautions: ["Do not fabricate measured ratios or convert governance limits into committed liquidation capacity.", "Record an evidence blocker when the issuer or chain does not expose the required metric."],
    ownerDomain: "backing",
    defaultResolutionMode: "issuer-or-onchain-evidence",
    reasonCodes: ["bounded-mechanism-review"],
    context: (asset) => asset.mechanismRiskReview,
    touchpoints: (source) => ["shared/data/safety-score-v9/mechanism-review-overlays-v1.json", base(source)],
  },
  MINT_AUTHORITY: {
    title: "Mint authority review", stream: "CTRL",
    instructions: "Populate the mintAuthority profile for every material issuance path: mint path, authority model and threshold, capabilities, reconciliation, cap semantics, upgradeability, controlRef, evidence, reviewer, and review date.",
    completionCriteria: "The mint economic-control review is known and a fresh exact replay removes the missing-mint-authority gapId.", recommendedSkill: null, likelyRepoAreas: ["shared/data/stablecoins/domains/mint-authority/", "shared/data/stablecoins/coins/"], cautions: ["Explorer/RPC structural reads should be pinned to a reviewed block or slot where practical."],
    ownerDomain: "control",
    defaultResolutionMode: "agent-curation",
    reasonCodes: [
      "missing-mint-authority",
      "mint-control-question",
      "unknown-control-mint-ability",
      "unresolved-mint-authority",
    ],
    context: (asset) => ({
      mint: asset.economicControlReview.mint,
      controls: asset.controls.filter((control) => control.capabilities.includes("mint")),
    }),
    touchpoints: (source) => unique([mint(source)]),
  },
  ORACLE_BRANCH: {
    title: "Oracle/liquidation branch review", stream: "ORCL",
    instructions: "Complete the named oracle branch with applicability, feed, collateral-parameter, liquidation, backstop, or shutdown/bad-debt facts, plus its controlling authority/mechanism identity and dated sources.",
    completionCriteria: "The named branch compiles as known or reviewed not-applicable and its gapId is absent from a fresh exact replay.", recommendedSkill: null, likelyRepoAreas: ["shared/data/stablecoins/domains/risk-review/", "shared/data/stablecoins/coins/"], cautions: ["Do not mark a branch not applicable merely because public documentation is incomplete."],
    ownerDomain: "control",
    defaultResolutionMode: "agent-curation",
    reasonCodes: [
      "incomplete-oracle-liquidation-branch",
      "missing-required-oracle-branches",
      "unresolved-oracle-branch-applicability",
    ],
    context: (asset) => asset.economicControlReview.oracle,
    touchpoints: (source) => unique([risk(source)]),
  },
  ORACLE_PROFILE: {
    title: "Oracle and liquidation profile", stream: "ORCL",
    instructions: "Populate oracleRisk with tier, branch model/applicability disposition, all required branch reviews, control or mechanism references, sources, reviewer, and review date. Use not-applicable only when no price-sensitive control exists; classify genuinely oracleless and privileged internal pricing separately.",
    completionCriteria: "The oracle economic-control review compiles as known or reviewed not-applicable and the profile gapId is absent.", recommendedSkill: null, likelyRepoAreas: ["shared/data/stablecoins/domains/risk-review/", "shared/data/stablecoins/coins/"], cautions: ["Use the live stabilization path, not only the token contract, to determine oracle applicability."],
    ownerDomain: "control",
    defaultResolutionMode: "agent-curation",
    reasonCodes: ["missing-oracle-profile", "unreviewed-oracle-profile"],
    context: (asset) => asset.economicControlReview.oracle,
    touchpoints: (source) => unique([risk(source)]),
  },
  PARENT_RATEABILITY: {
    title: "Required upstream parent rateability", stream: "methodology",
    instructions: "This gap is not curatable on the asset itself: a required upstream parent (serial dependency) has no score yet, so the child is unrateable until the parent rates. Resolve the parent's own missing-data work items — its evidence gaps are what actually need to close — and this asset rates transitively once the parent does.",
    completionCriteria: "A fresh exact replay reports the required upstream parent as rateable and removes the missing-parent-score gapId/nrReason for this asset.",
    recommendedSkill: null, likelyRepoAreas: ["shared/data/stablecoins/coins/"],
    cautions: ["Do not fabricate or bypass a parent score; work the parent's own missing-data items instead of editing this asset."],
    ownerDomain: "methodology",
    defaultResolutionMode: "agent-curation",
    reasonCodes: ["missing-parent-score"],
    context: (asset) => asset.dependencies,
    touchpoints: (source) => [base(source)],
  },
  PEG_INPUT: {
    title: "Current peg input", stream: "PEG",
    instructions: "Provide a resolvable peg reference and current peg observation with score, deviation, active-depeg state, tracking span, and failure-domain identity. Repair metadata/reference mapping or producer coverage as required; pure NAV assets need an explicit NAV disposition.",
    completionCriteria: "The exact fixed input contains a complete current peg row and a fresh replay removes the missing-peg-input gapId.", recommendedSkill: "stablecoin-info-fetch", likelyRepoAreas: ["shared/data/stablecoins/coins/", "worker/src/api/peg-summary.ts", "worker/src/lib/safety-score-v9-extension.ts", "shared/lib/peg-score.ts"], cautions: ["Do not invent a USD peg for an OTHER, index, commodity, or NAV reference."],
    ownerDomain: "peg",
    defaultResolutionMode: "mixed-curation-and-runtime",
    reasonCodes: [
      "missing-peg-input",
      "peg-price-unavailable-adverse-history",
      "peg-supply-floor-withheld",
      "missing-applicable-peg",
    ],
    context: (asset) => asset.peg,
    touchpoints: (source) => unique([base(source), "worker/src/lib/safety-score-v9-extension.ts"]),
  },
  RESERVE_COMPOSITION: {
    title: "Reserve composition envelope", stream: "RESV",
    instructions: "Author the current structured reserve envelope with slice names and weights, asset classes, issuer/obligor identity, risk factors, liquidity horizon, maturity where applicable, dependency links, reserveReview, custodyProfile, and latest assurance scope.",
    completionCriteria: "A fresh exact capture contains a reviewed reserve composition and removes the missing-reserve-composition gapId, or, for stale-audited-reserve-composition, refreshes reserves[] and compositionAsOf from the newest independent attestation; if the issuer has not published a newer composition, record the blocker and accept the audited-fallback adequate ceiling rather than restating expired evidence.", recommendedSkill: "reserve-research", likelyRepoAreas: ["shared/data/stablecoins/domains/reserves/", "shared/data/stablecoins/coins/"], cautions: ["Preserve documented unknown residuals instead of forcing an unsupported 100% allocation."],
    ownerDomain: "backing",
    defaultResolutionMode: "agent-curation",
    reasonCodes: [
      "material-unknown-reserve-exposure",
      "missing-custody-profile",
      "missing-latest-assurance-report",
      "missing-reserve-composition",
      "partial-reserve-review",
      "stale-audited-reserve-composition",
      "unreviewed-reserve-envelope",
    ],
    context: (asset) => ({
      reserveStatus: asset.reserveStatus,
      reserveExposures: asset.reserveExposures,
    }),
    touchpoints: (source) => unique([reserve(source)]),
  },
  RESERVE_SLICE: {
    title: "Structured material reserve slice", stream: "RESV",
    instructions: "Resolve the named captured exposure to a structured classification and failure-domain identity. Supply assetClass, issuerOrObligor, risk factors, liquidity horizon, maturity, tracked asset/dependency mapping, and sourced weight as applicable.",
    completionCriteria: "The exact exposure compiles as known and its material-reserve-slice-unstructured gapId is absent from a fresh replay.", recommendedSkill: "reserve-research", likelyRepoAreas: ["shared/data/stablecoins/domains/reserves/", "shared/data/stablecoins/coins/"], cautions: ["Match live exposure keys and current weights; do not reuse stale or unrelated portfolio composition."],
    ownerDomain: "backing",
    defaultResolutionMode: "agent-curation",
    reasonCodes: ["material-reserve-slice-unstructured"],
    context: (asset) => ({
      reserveStatus: asset.reserveStatus,
      reserveExposures: asset.reserveExposures,
    }),
    touchpoints: (source) => unique([reserve(source)]),
  },
};

type GapPath = V9EvidenceGapQueueEntryV2["path"];

function descriptorByReason(reason: string): WorkTypeDescriptor | undefined {
  return Object.values(V9_MISSING_DATA_WORK_TYPES).find((descriptor) => descriptor.reasonCodes.includes(reason));
}

function normalizeComponentKey(value: string): string {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function mechanismContext(asset: V9AssetFactsV3, componentKey: string): unknown {
  if (componentKey === "mechanism-risk-review") return asset.mechanismRiskReview;
  const requested = componentKey.split(":").at(-1) ?? componentKey;
  const review = asset.mechanismRiskReview.review as unknown as Record<string, unknown> | null;
  const match = review ? Object.entries(review).find(([key]) => normalizeComponentKey(key) === normalizeComponentKey(requested)) : null;
  return { reviewStatus: asset.mechanismRiskReview.status, componentKey: match?.[0] ?? requested, component: match?.[1] ?? null };
}

function contextForPath(path: GapPath): WorkTypeDescriptor["context"] {
  if (path.kind === "collateral-exposure") return (asset) => asset.reserveExposures.find((row) => row.exposureKey === path.exposureKey) ?? null;
  if (path.kind === "optional-exit") return (asset) => asset.exitRoutes.find((row) => row.routeKey === path.routeKey) ?? null;
  if (path.kind === "deployment-control") return (asset) => asset.controls.find((row) => row.controlKey === path.controlKey) ?? null;
  if (path.kind === "serial-dependency") return (asset) => asset.dependencies.edges.find((row) => row.upstreamAssetId === path.upstreamAssetId && row.dependencyType === path.dependencyType) ?? null;
  if (path.kind === "peg") return (asset) => asset.peg;
  if (path.kind === "methodology") return V9_MISSING_DATA_WORK_TYPES.ARCHETYPE_CLASSIFICATION.context;
  const componentKey = path.componentKey;
  if (componentKey === "chain-supply" || componentKey === "bridge-materiality") return (asset) => asset.supply;
  if (componentKey === "implementation-date") return (asset) => asset.implementation;
  if (componentKey === "mechanism-risk-review" || componentKey.startsWith("mechanism-review:")) return (asset) => mechanismContext(asset, componentKey);
  if (componentKey === "reserve-composition") return (asset) => ({ reserveStatus: asset.reserveStatus, exposures: asset.reserveExposures.map(({ exposureKey, name, weight, status }) => ({ exposureKey, name, weight, status })) });
  if (componentKey === "exit-routes" || componentKey === "exit-portfolio-coverage") return exitContext;
  if (componentKey === "deployment-controls") return (asset) => ({ controlStatus: asset.controlStatus, controls: asset.controls, mint: asset.economicControlReview.mint });
  if (componentKey === "economic-control:mint") return (asset) => asset.economicControlReview.mint;
  if (componentKey === "economic-control:bridge") return (asset) => asset.economicControlReview.bridge;
  if (componentKey === "economic-control:oracle") return (asset) => asset.economicControlReview.oracle;
  if (componentKey.startsWith("economic-control:oracle:")) return (asset) => asset.economicControlReview.oracle.branches.find((row) => row.branch === componentKey.slice("economic-control:oracle:".length)) ?? null;
  if (componentKey === "effective-dependencies") return (asset) => asset.dependencies;
  if (componentKey === "peg") return (asset) => asset.peg;
  if (componentKey === "access:transfer") return (asset) => asset.accessReview.transfer;
  if (componentKey === "access:freeze") return (asset) => asset.accessReview.freeze;
  if (componentKey.startsWith("access:freeze:")) return (asset) => asset.accessReview.freeze.reviews.find((row) => row.reviewKey === componentKey.slice("access:freeze:".length)) ?? asset.accessReview.freeze;
  return () => null;
}

export function descriptorForReason(reason: string, path?: GapPath): WorkTypeDescriptor {
  let descriptor = descriptorByReason(reason);
  // missing-pillar-evidence intentionally routes by local component because its
  // reason code alone does not identify a work type.
  if (!descriptor && reason === "missing-pillar-evidence" && path?.kind === "local-component") {
    if (path.componentKey === "chain-supply") descriptor = V9_MISSING_DATA_WORK_TYPES.CHAIN_SUPPLY;
    if (path.componentKey.startsWith("access:")) descriptor = V9_MISSING_DATA_WORK_TYPES.ACCESS_REVIEW;
  }
  if (!descriptor) throw new Error(`Missing agent work-type definition for ${reason} at ${JSON.stringify(path)}`);
  return path ? { ...descriptor, context: contextForPath(path) } : descriptor;
}

export function workTypeForDescriptor(descriptor: WorkTypeDescriptor): WorkType {
  const match = Object.entries(V9_MISSING_DATA_WORK_TYPES).find(([, candidate]) => candidate === descriptor || candidate.title === descriptor.title);
  if (!match) throw new Error(`Missing work type for descriptor ${descriptor.title}`);
  return match[0] as WorkType;
}
