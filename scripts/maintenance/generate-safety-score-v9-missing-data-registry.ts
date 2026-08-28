import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { readCompiledV9FactSetForEvaluation } from "@shared/lib/safety-score-v9/facts";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import {
  V9EvidenceGapQueueV2Schema,
  type V9EvidenceGapQueueEntryV2,
} from "@shared/types/safety-score-v9-evidence-queue";
import { SafetyScoreV9ResponseSchema, type SafetyScoreV9Card } from "@shared/types/safety-score-v9-public";
import { loadPerCoinStablecoinEntries, type StablecoinSourceEntry } from "../lib/stablecoin-catalog-sources";
import {
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeCliHelpIfRequested,
  writeJsonOutput,
} from "../lib/cli-args.mjs";

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-missing-data-registry.ts [options]

Options:
  --replay <path>         Exact Safety Score v9 replay JSON (required)
  --policy <path>         Explicit V9 methodology policy JSON (required)
  --output <path>         Agent-oriented missing-data registry JSON (required)
  -h, --help              Show this help`;

const ReplayArtifactSchema = z
  .object({
    pipeline: z
      .object({
        candidate: SafetyScoreV9ResponseSchema,
        compiledFacts: z.unknown(),
      })
      .passthrough(),
  })
  .passthrough();

export type V9MissingDataWorkType =
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
  | "IMPLEMENTATION_DATE"
  | "MECHANISM_REVIEW"
  | "MINT_AUTHORITY"
  | "ORACLE_BRANCH"
  | "ORACLE_PROFILE"
  | "PEG_INPUT"
  | "RESERVE_COMPOSITION"
  | "RESERVE_SLICE";

export type V9MissingDataResolutionMode =
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

const WORK_TYPES: Record<V9MissingDataWorkType, WorkTypeDefinition> = {
  ACCESS_REVIEW: {
    title: "Transfer and freeze access review",
    stream: "CTRL",
    instructions:
      "Research the current transfer-restriction and freeze/blacklist posture, including reach, controlling authority, inherited upstream exposure, and failure-domain identity. Add a dated, sourced blacklistabilityReview in the risk-review sidecar or base coin record.",
    completionCriteria:
      "A fresh exact replay reports known transfer and freeze access facts and the listed access gapId is absent.",
    recommendedSkill: "stablecoin-info-fetch",
    likelyRepoAreas: ["shared/data/stablecoins/domains/risk-review/", "shared/data/stablecoins/coins/"],
    cautions: [
      "Review every material deployment and inherited wrapper exposure; a token-level boolean alone is insufficient.",
    ],
  },
  ARCHETYPE_CLASSIFICATION: {
    title: "Mechanism archetype classification",
    stream: "ARCH",
    instructions:
      "Assign the mechanismArchetype that matches the live stabilization and claim structure, with a sourced mechanismArchetypeReview. Record an intentional parent divergence with archetypeOverride when applicable.",
    completionCriteria: "A fresh exact replay resolves the archetype and removes the missing-archetype gapId.",
    recommendedSkill: "resilience-classify",
    likelyRepoAreas: ["shared/data/stablecoins/coins/"],
    cautions: ["Classification clears NR eligibility but does not assert that the mechanism is safe."],
  },
  BRIDGE_MATERIALITY: {
    title: "Bridge deployment materiality",
    stream: "BRDG",
    instructions:
      "Reconcile current chain-level circulating USD to reviewed deployment routes so selected, unknown, and unreviewed bridge supply shares are explicit. This usually needs both complete route metadata and a fresh chain-supply producer capture.",
    completionCriteria:
      "A fresh exact replay has current bridge supply shares and removes the runtime-bridge-materiality-unavailable gapId.",
    recommendedSkill: "contract-enrich",
    likelyRepoAreas: [
      "shared/data/stablecoins/domains/risk-review/",
      "shared/data/stablecoins/coins/",
      "worker/src/lib/safety-score-v9-extension-supply.ts",
      "worker/src/cron/snapshot-chain-supply.ts",
    ],
    cautions: ["Do not add a manual supply override or multiply DefiLlama list-endpoint circulating USD by price."],
  },
  BRIDGE_ROUTE_REVIEW: {
    title: "Bridge route control review",
    stream: "BRDG",
    instructions:
      "Populate the material bridgeRouteRisk route rows with route identity, scope, issuance model, verification/control model, risk tier, sources, reviewer, and review date. Explicitly rule native-only deployments not applicable when supported.",
    completionCriteria:
      "A fresh exact replay resolves the bridge economic-control review and removes the listed bridge gapId.",
    recommendedSkill: "stablecoin-info-fetch",
    likelyRepoAreas: ["shared/data/stablecoins/domains/risk-review/", "shared/data/stablecoins/coins/"],
    cautions: ["Only reviewed, runtime-selected material routes should influence the score."],
  },
  CHAIN_SUPPLY: {
    title: "Current chain supply evidence",
    stream: "SUPPLY",
    instructions:
      "Restore a current, score-eligible circulating-USD observation for the asset. Verify provider identity, price path, contracts, and chain coverage; enrich missing deployments or repair producer mapping when needed.",
    completionCriteria:
      "The exact fixed input contains current chain supply, the compiled supply status is known, and the chain-supply gapId is absent.",
    recommendedSkill: "stablecoin-runtime-price-marketcap-gate",
    likelyRepoAreas: [
      "shared/data/stablecoins/coins/",
      "worker/src/cron/sync-stablecoins.ts",
      "worker/src/cron/snapshot-chain-supply.ts",
      "worker/src/lib/safety-score-v9-extension-supply.ts",
    ],
    cautions: [
      "Use getCirculatingRaw(); DefiLlama list circulating values are already USD-denominated.",
      "Do not add manual, on-chain, CMC, DEX, or other supply overrides.",
    ],
  },
  DEPENDENCY_REVIEW: {
    title: "Effective dependency relationship review",
    stream: "DEP",
    instructions:
      "Review the complete effective dependency set. Map proportional collateral exposures to exact upstream asset IDs and weights, and record wrapper/mechanism dependencies as explicit serial edges with dated evidence.",
    completionCriteria:
      "The compiled dependency graph is valid and known, and a fresh exact replay removes the dependency gapId.",
    recommendedSkill: "reserve-research",
    likelyRepoAreas: ["shared/data/stablecoins/domains/reserves/", "shared/data/stablecoins/coins/"],
    cautions: [
      "Do not create a dependency merely because two assets share an issuer, chain, custodian, or trading pair.",
    ],
  },
  DEPLOYMENT_CONTROLS: {
    title: "Deployment control identity and upgrade review",
    stream: "CTRL",
    instructions:
      "Resolve every material deployment control: authority identity/model and threshold, capabilities, cap semantics, delay, incident state, material share, claim-impairment scope, economic-loss scope, and failure domains. Complete the upgrade posture and controlRef links.",
    completionCriteria:
      "All required deployment controls compile as known and the listed control or upgradeability gapId is absent from a fresh exact replay.",
    recommendedSkill: null,
    likelyRepoAreas: [
      "shared/data/stablecoins/domains/mint-authority/",
      "shared/data/stablecoins/domains/risk-review/",
      "shared/data/stablecoins/coins/",
    ],
    cautions: ["Multichain assets require the authority graph for every material deployment."],
  },
  EXIT_DEX_COVERAGE: {
    title: "Exact DEX route coverage",
    stream: "EXIT",
    instructions:
      "Make every retained material DEX pool carry a score-eligible exact route observation: supported pool math, explicit output valuation, request/capacity curve, settlement facts, resource identity, and failure domains. Unsupported pool archetypes require producer capability, not a hand-entered estimate.",
    completionCriteria:
      "A fresh exact capture marks the retained DEX portfolio exact-complete and removes the incomplete-dex-route-coverage gapId.",
    recommendedSkill: null,
    likelyRepoAreas: [
      "worker/src/cron/dex-liquidity/",
      "worker/src/lib/dex-liquidity.ts",
      "worker/src/lib/safety-score-v9-extension.ts",
      "shared/lib/dex-liquidity-evidence.ts",
    ],
    cautions: [
      "Do not substitute TVL, generic liquidity, or a manually estimated capacity curve for exact executable depth.",
    ],
  },
  EXIT_OUTPUT: {
    title: "Exit route output valuation",
    stream: "EXIT",
    instructions:
      "Identify the actual asset or basket delivered by the route and provide same-notional USD valuation. For documented redemption rails, add outputAssets to the matching redemption config; for DEX routes, repair producer token/output resolution.",
    completionCriteria:
      "The route output is explicit and valued in a fresh exact capture, and the route-specific unresolved-exit-output gapId is absent.",
    recommendedSkill: null,
    likelyRepoAreas: ["shared/lib/redemption-backstop-configs/", "worker/src/lib/safety-score-v9-extension.ts"],
    cautions: ["Only name an output that the route documentation or on-chain execution actually establishes."],
  },
  EXIT_RUNTIME_ROUTE: {
    title: "Runtime exit route evidence",
    stream: "EXIT",
    instructions:
      "Produce at least one current exact DEX, redemption, or retained route observation with comparable notional, capacity, cost, access, settlement, output valuation, and failure-domain evidence.",
    completionCriteria:
      "The exact fixed input contains a score-eligible route and a fresh replay removes the missing-runtime-route-evidence gapId.",
    recommendedSkill: null,
    likelyRepoAreas: [
      "worker/src/cron/dex-liquidity/",
      "worker/src/cron/sync-redemption-backstops.ts",
      "worker/src/lib/redemption-exit-route-observations.ts",
      "worker/src/lib/safety-score-v9-extension.ts",
    ],
    cautions: ["A source-only metadata edit is not complete until a fresh producer capture embeds the observation."],
  },
  IMPLEMENTATION_DATE: {
    title: "Current mechanism implementation date",
    stream: "EVID",
    instructions:
      "Research the launch date of the currently scored mechanism boundary and populate implementationLaunchDate. Use the conservative range end for fuzzy dates and cite the source in the surrounding reviewed metadata or batch report.",
    completionCriteria:
      "The compiled launchedAtSec is known and a fresh exact replay removes the missing-implementation-date gapId.",
    recommendedSkill: "stablecoin-info-fetch",
    likelyRepoAreas: ["shared/data/stablecoins/coins/"],
    cautions: ["Do not use an earlier predecessor launch if the current mechanism was materially replaced."],
  },
  MECHANISM_REVIEW: {
    title: "Mechanism risk component review",
    stream: "MECH",
    instructions:
      "Curate source-backed facts for the exact mechanism component in the mechanism-review overlay. Fiat-cash, T-bill, and commodity-claim components must satisfy the ratified strict evidence standard; when disclosure is insufficient, record a sourced unavailable disposition that remains bounded and non-scoring. Advanced archetypes require the complete measured-metric overlay.",
    completionCriteria:
      "A fresh exact replay either compiles the exact component as known and removes its bounded-mechanism-review gapId, or confirms that an independently reviewed unavailable disposition retains the bounded-unknown gap without changing score or grade.",
    recommendedSkill: "reserve-research",
    likelyRepoAreas: [
      "shared/data/safety-score-v9/mechanism-review-overlays-v1.json",
      "shared/data/stablecoins/domains/reserves/",
      "shared/data/stablecoins/coins/",
      "worker/src/lib/safety-score-v9-extension-mechanism.ts",
    ],
    cautions: [
      "Do not fabricate measured ratios or convert governance limits into committed liquidation capacity.",
      "Record an evidence blocker when the issuer or chain does not expose the required metric.",
    ],
  },
  MINT_AUTHORITY: {
    title: "Mint authority review",
    stream: "CTRL",
    instructions:
      "Populate the mintAuthority profile for every material issuance path: mint path, authority model and threshold, capabilities, reconciliation, cap semantics, upgradeability, controlRef, evidence, reviewer, and review date.",
    completionCriteria:
      "The mint economic-control review is known and a fresh exact replay removes the missing-mint-authority gapId.",
    recommendedSkill: null,
    likelyRepoAreas: ["shared/data/stablecoins/domains/mint-authority/", "shared/data/stablecoins/coins/"],
    cautions: ["Explorer/RPC structural reads should be pinned to a reviewed block or slot where practical."],
  },
  ORACLE_BRANCH: {
    title: "Oracle/liquidation branch review",
    stream: "ORCL",
    instructions:
      "Complete the named oracle branch with applicability, feed, collateral-parameter, liquidation, backstop, or shutdown/bad-debt facts, plus its controlling authority/mechanism identity and dated sources.",
    completionCriteria:
      "The named branch compiles as known or reviewed not-applicable and its gapId is absent from a fresh exact replay.",
    recommendedSkill: null,
    likelyRepoAreas: ["shared/data/stablecoins/domains/risk-review/", "shared/data/stablecoins/coins/"],
    cautions: ["Do not mark a branch not applicable merely because public documentation is incomplete."],
  },
  ORACLE_PROFILE: {
    title: "Oracle and liquidation profile",
    stream: "ORCL",
    instructions:
      "Populate oracleRisk with tier, branch model/applicability disposition, all required branch reviews, control or mechanism references, sources, reviewer, and review date. Use not-applicable only when no price-sensitive control exists; classify genuinely oracleless and privileged internal pricing separately.",
    completionCriteria:
      "The oracle economic-control review compiles as known or reviewed not-applicable and the profile gapId is absent.",
    recommendedSkill: null,
    likelyRepoAreas: ["shared/data/stablecoins/domains/risk-review/", "shared/data/stablecoins/coins/"],
    cautions: ["Use the live stabilization path, not only the token contract, to determine oracle applicability."],
  },
  PEG_INPUT: {
    title: "Current peg input",
    stream: "PEG",
    instructions:
      "Provide a resolvable peg reference and current peg observation with score, deviation, active-depeg state, tracking span, and failure-domain identity. Repair metadata/reference mapping or producer coverage as required; pure NAV assets need an explicit NAV disposition.",
    completionCriteria:
      "The exact fixed input contains a complete current peg row and a fresh replay removes the missing-peg-input gapId.",
    recommendedSkill: "stablecoin-info-fetch",
    likelyRepoAreas: [
      "shared/data/stablecoins/coins/",
      "worker/src/api/peg-summary.ts",
      "worker/src/lib/safety-score-v9-extension.ts",
      "shared/lib/peg-score.ts",
    ],
    cautions: ["Do not invent a USD peg for an OTHER, index, commodity, or NAV reference."],
  },
  RESERVE_COMPOSITION: {
    title: "Reserve composition envelope",
    stream: "RESV",
    instructions:
      "Author the current structured reserve envelope with slice names and weights, asset classes, issuer/obligor identity, risk factors, liquidity horizon, maturity where applicable, dependency links, reserveReview, custodyProfile, and latest assurance scope.",
    completionCriteria:
      "A fresh exact capture contains a reviewed reserve composition and removes the missing-reserve-composition gapId.",
    recommendedSkill: "reserve-research",
    likelyRepoAreas: ["shared/data/stablecoins/domains/reserves/", "shared/data/stablecoins/coins/"],
    cautions: ["Preserve documented unknown residuals instead of forcing an unsupported 100% allocation."],
  },
  RESERVE_SLICE: {
    title: "Structured material reserve slice",
    stream: "RESV",
    instructions:
      "Resolve the named captured exposure to a structured classification and failure-domain identity. Supply assetClass, issuerOrObligor, risk factors, liquidity horizon, maturity, tracked asset/dependency mapping, and sourced weight as applicable.",
    completionCriteria:
      "The exact exposure compiles as known and its material-reserve-slice-unstructured gapId is absent from a fresh replay.",
    recommendedSkill: "reserve-research",
    likelyRepoAreas: ["shared/data/stablecoins/domains/reserves/", "shared/data/stablecoins/coins/"],
    cautions: ["Match live exposure keys and current weights; do not reuse stale or unrelated portfolio composition."],
  },
};

export function workTypeDefinition(workType: V9MissingDataWorkType): Readonly<WorkTypeDefinition> {
  return WORK_TYPES[workType];
}

const WORK_TYPE_BY_REASON: Partial<Record<string, V9MissingDataWorkType>> = {
  "bounded-mechanism-review": "MECHANISM_REVIEW",
  "missing-access-review": "ACCESS_REVIEW",
  "incomplete-dex-route-coverage": "EXIT_DEX_COVERAGE",
  "incomplete-oracle-liquidation-branch": "ORACLE_BRANCH",
  "inherited-access-exposure": "ACCESS_REVIEW",
  "reviewed-possible-access": "ACCESS_REVIEW",
  "material-reserve-slice-unstructured": "RESERVE_SLICE",
  "material-unknown-reserve-exposure": "RESERVE_COMPOSITION",
  "missing-archetype": "ARCHETYPE_CLASSIFICATION",
  "missing-bridge-routes": "BRIDGE_ROUTE_REVIEW",
  "missing-custody-profile": "RESERVE_COMPOSITION",
  "missing-implementation-date": "IMPLEMENTATION_DATE",
  "missing-latest-assurance-report": "RESERVE_COMPOSITION",
  "missing-mint-authority": "MINT_AUTHORITY",
  "missing-oracle-profile": "ORACLE_PROFILE",
  "missing-peg-input": "PEG_INPUT",
  "missing-reserve-composition": "RESERVE_COMPOSITION",
  "peg-price-unavailable-adverse-history": "PEG_INPUT",
  "peg-supply-floor-withheld": "PEG_INPUT",
  "missing-runtime-route-evidence": "EXIT_RUNTIME_ROUTE",
  "missing-upgradeability-review": "DEPLOYMENT_CONTROLS",
  "runtime-bridge-materiality-unavailable": "BRIDGE_MATERIALITY",
  "scoped-control-question": "DEPLOYMENT_CONTROLS",
  "unresolved-control-identity": "DEPLOYMENT_CONTROLS",
  "unresolved-exit-output": "EXIT_OUTPUT",
  "unreviewed-dependency-relationships": "DEPENDENCY_REVIEW",
};

const SCORE_PROJECTION_WORK_TYPE_BY_REASON: Partial<Record<string, V9MissingDataWorkType>> = {
  ...WORK_TYPE_BY_REASON,
  "incomparable-route-requests": "EXIT_RUNTIME_ROUTE",
  "insufficient-evidence": "ARCHETYPE_CLASSIFICATION",
  "material-bridge-supply-unmatched": "BRIDGE_MATERIALITY",
  "material-dependency-unavailable": "DEPENDENCY_REVIEW",
  "missing-applicable-peg": "PEG_INPUT",
  "missing-bridge-route-rows": "BRIDGE_ROUTE_REVIEW",
  "missing-bridge-route": "BRIDGE_ROUTE_REVIEW",
  "missing-pillar": "ARCHETYPE_CLASSIFICATION",
  "missing-required-oracle-branches": "ORACLE_BRANCH",
  "missing-same-notional-route": "EXIT_RUNTIME_ROUTE",
  "missing-upgrade-control": "DEPLOYMENT_CONTROLS",
  "mint-control-question": "MINT_AUTHORITY",
  "nonmaterial-bridge-supply-unmatched": "BRIDGE_MATERIALITY",
  "nonmaterial-dependency-unavailable": "DEPENDENCY_REVIEW",
  "partial-reserve-review": "RESERVE_COMPOSITION",
  "selected-bridge-route-missing": "BRIDGE_ROUTE_REVIEW",
  "selected-bridge-route-unresolved": "BRIDGE_ROUTE_REVIEW",
  "unknown-control-cap-authority": "DEPLOYMENT_CONTROLS",
  "unknown-control-mint-ability": "MINT_AUTHORITY",
  "unknown-upgrade-authority": "DEPLOYMENT_CONTROLS",
  "unresolved-mint-authority": "MINT_AUTHORITY",
  "unresolved-oracle-branch-applicability": "ORACLE_BRANCH",
  "unreviewed-oracle-profile": "ORACLE_PROFILE",
  "unreviewed-reserve-envelope": "RESERVE_COMPOSITION",
  "unsupported-same-notional-route": "EXIT_DEX_COVERAGE",
};

export function classifyV9MissingDataWorkType(
  entry: Pick<V9EvidenceGapQueueEntryV2, "reasonCode" | "path">,
): V9MissingDataWorkType {
  if (entry.reasonCode === "missing-pillar-evidence" && entry.path.kind === "local-component") {
    if (entry.path.componentKey === "chain-supply") return "CHAIN_SUPPLY";
    if (entry.path.componentKey.startsWith("access:")) return "ACCESS_REVIEW";
  }
  const workType = WORK_TYPE_BY_REASON[entry.reasonCode];
  if (!workType) {
    throw new Error(`Missing agent work-type definition for ${entry.reasonCode} at ${JSON.stringify(entry.path)}`);
  }
  return workType;
}

export function classifyV9ScoreProjectionWorkType(reasonCode: string): V9MissingDataWorkType | null {
  return SCORE_PROJECTION_WORK_TYPE_BY_REASON[reasonCode] ?? null;
}

/**
 * Archetypes whose mechanism components are curated directly from issuer
 * disclosure under the ratified strict evidence standard, rather than waiting
 * on a measured-metric producer capability.
 */
const DIRECT_CURATION_MECHANISM_ARCHETYPES: ReadonlySet<string> = new Set([
  "fiat-cash",
  "tbill",
  "commodity-claim",
]);

export function mechanismResolutionMode(
  entry: Pick<V9EvidenceGapQueueEntryV2, "archetype" | "path">,
): V9MissingDataResolutionMode {
  // Wave-7 D3 ratified direct overlay curation for every fiat-cash and
  // T-bill mechanism component under the strict evidence standard. v9.14 adds
  // commodity-claim, whose components are curated from the same class of
  // issuer disclosure (bar lists, vault terms, redemption terms).
  if (DIRECT_CURATION_MECHANISM_ARCHETYPES.has(entry.archetype)) return "agent-curation";
  return "issuer-or-onchain-evidence";
}

function resolutionModeFor(
  workType: V9MissingDataWorkType,
  entry: V9EvidenceGapQueueEntryV2,
  context: unknown,
): V9MissingDataResolutionMode {
  if (workType === "MECHANISM_REVIEW") return mechanismResolutionMode(entry);
  if (workType === "CHAIN_SUPPLY" || workType === "BRIDGE_MATERIALITY" || workType === "PEG_INPUT") {
    return "mixed-curation-and-runtime";
  }
  if (workType === "EXIT_DEX_COVERAGE" || workType === "EXIT_RUNTIME_ROUTE") return "producer-runtime";
  if (workType === "EXIT_OUTPUT") {
    const lane = typeof context === "object" && context !== null && "lane" in context ? context.lane : null;
    return lane === "dex" ? "producer-runtime" : "agent-curation";
  }
  return "agent-curation";
}

function evidenceAction(entry: V9EvidenceGapQueueEntryV2, mode: V9MissingDataResolutionMode): string {
  if (entry.responsibility === "issuer-undisclosed") return "obtain-issuer-or-onchain-disclosure";
  if (entry.responsibility === "integration-missing") return "repair-fact-integration";
  if (entry.responsibility === "producer-failed") return "repair-or-refresh-producer";
  if (entry.responsibility === "method-unsupported") return "define-reviewed-methodology-capability";
  if (entry.responsibility === "measured-adverse") return "adjudicate-measured-adverse-evidence";
  if (mode === "producer-runtime") return "implement-or-refresh-producer-capability";
  if (mode === "mixed-curation-and-runtime") return "reconcile-metadata-then-refresh-producer";
  if (mode === "methodology-capability") return "define-reviewed-methodology-capability";
  if (mode === "issuer-or-onchain-evidence") return "obtain-measured-source-evidence-then-curate";
  if (entry.observationState === "missing") return "collect-and-curate-evidence";
  if (entry.observationState === "stale") return "refresh-and-curate-evidence";
  if (entry.observationState === "unsupported") return "implement-supported-evidence-path";
  return "adjudicate-and-curate-bounded-unknown";
}

export function scoreProjectionResolutionMode(
  workType: V9MissingDataWorkType,
  archetype: V9EvidenceGapQueueEntryV2["archetype"],
): V9MissingDataResolutionMode {
  if (workType === "BRIDGE_MATERIALITY" || workType === "CHAIN_SUPPLY" || workType === "PEG_INPUT") {
    return "mixed-curation-and-runtime";
  }
  if (workType === "EXIT_DEX_COVERAGE" || workType === "EXIT_RUNTIME_ROUTE") return "producer-runtime";
  if (workType === "MECHANISM_REVIEW") {
    return DIRECT_CURATION_MECHANISM_ARCHETYPES.has(archetype) ? "agent-curation" : "issuer-or-onchain-evidence";
  }
  return "agent-curation";
}

function scoreProjectionAction(mode: V9MissingDataResolutionMode): string {
  if (mode === "producer-runtime") return "implement-or-refresh-producer-capability";
  if (mode === "mixed-curation-and-runtime") return "reconcile-metadata-then-refresh-producer";
  if (mode === "methodology-capability") return "define-reviewed-methodology-capability";
  if (mode === "issuer-or-onchain-evidence") return "obtain-measured-source-evidence-then-curate";
  return "adjudicate-and-curate-score-projection";
}

function normalizeComponentKey(value: string): string {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function mechanismContext(asset: V9AssetFactsV3, componentKey: string): unknown {
  if (componentKey === "mechanism-risk-review") return asset.mechanismRiskReview;
  const requested = componentKey.split(":").at(-1) ?? componentKey;
  const review = asset.mechanismRiskReview.review as unknown as Record<string, unknown> | null;
  const match = review
    ? Object.entries(review).find(([key]) => normalizeComponentKey(key) === normalizeComponentKey(requested))
    : null;
  return {
    reviewStatus: asset.mechanismRiskReview.status,
    componentKey: match?.[0] ?? requested,
    component: match?.[1] ?? null,
  };
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

function currentFactContext(entry: V9EvidenceGapQueueEntryV2, asset: V9AssetFactsV3): unknown {
  const path = entry.path;
  if (path.kind === "collateral-exposure") {
    return asset.reserveExposures.find((exposure) => exposure.exposureKey === path.exposureKey) ?? null;
  }
  if (path.kind === "optional-exit") {
    return asset.exitRoutes.find((route) => route.routeKey === path.routeKey) ?? null;
  }
  if (path.kind === "deployment-control") {
    return asset.controls.find((control) => control.controlKey === path.controlKey) ?? null;
  }
  if (path.kind === "serial-dependency") {
    return (
      asset.dependencies.edges.find(
        (edge) => edge.upstreamAssetId === path.upstreamAssetId && edge.dependencyType === path.dependencyType,
      ) ?? null
    );
  }
  if (path.kind === "peg") return asset.peg;
  if (path.kind === "methodology")
    return { archetype: asset.archetype, mechanismRiskReview: asset.mechanismRiskReview };
  const componentKey = path.componentKey;
  if (componentKey === "chain-supply" || componentKey === "bridge-materiality") return asset.supply;
  if (componentKey === "implementation-date") return asset.implementation;
  if (componentKey === "mechanism-risk-review" || componentKey.startsWith("mechanism-review:")) {
    return mechanismContext(asset, componentKey);
  }
  if (componentKey === "reserve-composition") {
    return {
      reserveStatus: asset.reserveStatus,
      exposures: asset.reserveExposures.map((exposure) => ({
        exposureKey: exposure.exposureKey,
        name: exposure.name,
        weight: exposure.weight,
        status: exposure.status,
      })),
    };
  }
  if (componentKey === "exit-routes" || componentKey === "exit-portfolio-coverage") {
    return { exitStatus: asset.exitStatus, routes: asset.exitRoutes.map(routeSummary) };
  }
  if (componentKey === "deployment-controls") {
    return { controlStatus: asset.controlStatus, controls: asset.controls, mint: asset.economicControlReview.mint };
  }
  if (componentKey === "economic-control:mint") return asset.economicControlReview.mint;
  if (componentKey === "economic-control:bridge") return asset.economicControlReview.bridge;
  if (componentKey === "economic-control:oracle") return asset.economicControlReview.oracle;
  if (componentKey.startsWith("economic-control:oracle:")) {
    const branch = componentKey.slice("economic-control:oracle:".length);
    return asset.economicControlReview.oracle.branches.find((row) => row.branch === branch) ?? null;
  }
  if (componentKey === "effective-dependencies") return asset.dependencies;
  if (componentKey === "peg") return asset.peg;
  if (componentKey === "access:transfer") return asset.accessReview.transfer;
  if (componentKey === "access:freeze") return asset.accessReview.freeze;
  if (componentKey.startsWith("access:freeze:")) {
    const reviewKey = componentKey.slice("access:freeze:".length);
    return (
      asset.accessReview.freeze.reviews.find((review) => review.reviewKey === reviewKey) ?? asset.accessReview.freeze
    );
  }
  return null;
}

function currentWorkTypeContext(workType: V9MissingDataWorkType, asset: V9AssetFactsV3): unknown {
  switch (workType) {
    case "ACCESS_REVIEW":
      return asset.accessReview;
    case "ARCHETYPE_CLASSIFICATION":
      return { archetype: asset.archetype, mechanismRiskReview: asset.mechanismRiskReview };
    case "BRIDGE_MATERIALITY":
      return { supply: asset.supply, bridge: asset.economicControlReview.bridge, controls: asset.controls };
    case "BRIDGE_ROUTE_REVIEW":
      return { bridge: asset.economicControlReview.bridge, controls: asset.controls };
    case "CHAIN_SUPPLY":
      return asset.supply;
    case "DEPENDENCY_REVIEW":
      return asset.dependencies;
    case "DEPLOYMENT_CONTROLS":
      return {
        controlStatus: asset.controlStatus,
        controls: asset.controls,
        economicControlReview: asset.economicControlReview,
      };
    case "EXIT_DEX_COVERAGE":
    case "EXIT_RUNTIME_ROUTE":
      return { exitStatus: asset.exitStatus, routes: asset.exitRoutes.map(routeSummary) };
    case "EXIT_OUTPUT":
      return { exitStatus: asset.exitStatus, routes: asset.exitRoutes.map(routeSummary) };
    case "IMPLEMENTATION_DATE":
      return asset.implementation;
    case "MECHANISM_REVIEW":
      return asset.mechanismRiskReview;
    case "MINT_AUTHORITY":
      return {
        mint: asset.economicControlReview.mint,
        controls: asset.controls.filter((control) => control.capabilities.includes("mint")),
      };
    case "ORACLE_BRANCH":
    case "ORACLE_PROFILE":
      return asset.economicControlReview.oracle;
    case "PEG_INPUT":
      return asset.peg;
    case "RESERVE_COMPOSITION":
    case "RESERVE_SLICE":
      return { reserveStatus: asset.reserveStatus, reserveExposures: asset.reserveExposures };
  }
}

function collectEvidenceRefIds(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectEvidenceRefIds(entry, output);
    return output;
  }
  if (typeof value !== "object" || value === null) return output;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "evidenceRefIds" && Array.isArray(entry)) {
      for (const evidenceRefId of entry) if (typeof evidenceRefId === "string") output.add(evidenceRefId);
      continue;
    }
    collectEvidenceRefIds(entry, output);
  }
  return output;
}

interface ScoreProjectionReason {
  reasonCode: string;
  message: string;
  path: string | null;
  source: string;
  workType: V9MissingDataWorkType;
}

function scoreProjectionReasons(card: SafetyScoreV9Card): ScoreProjectionReason[] {
  const reasons: ScoreProjectionReason[] = [];
  for (const pillar of ["backing", "exit", "control"] as const) {
    for (const reason of card.pillars[pillar].reasons) {
      const workType = classifyV9ScoreProjectionWorkType(reason.code);
      if (workType) reasons.push({ ...reason, reasonCode: reason.code, source: `pillar:${pillar}`, workType });
    }
  }
  for (const reason of card.nrReasons) {
    const workType = classifyV9ScoreProjectionWorkType(reason.code);
    if (workType) {
      reasons.push({
        reasonCode: reason.code,
        message: reason.message,
        path: reason.field,
        source: "nr-reason",
        workType,
      });
    }
  }
  const detailedCodes = new Set(reasons.map((reason) => reason.reasonCode));
  for (const reasonCode of card.reasonCodes) {
    const workType = classifyV9ScoreProjectionWorkType(reasonCode);
    if (!workType || detailedCodes.has(reasonCode)) continue;
    const cap = card.caps.find((entry) => entry.kind === `reason:${reasonCode}`);
    reasons.push({
      reasonCode,
      message: cap?.reason ?? reasonCode,
      path: null,
      source: "card-aggregate",
      workType,
    });
  }
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = `${reason.reasonCode}|${reason.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreProjectionObservationState(reasonCode: string): string {
  if (reasonCode.startsWith("missing") || reasonCode === "insufficient-evidence") return "missing";
  if (reasonCode.startsWith("unsupported")) return "unsupported";
  return "bounded-unknown";
}

function scoreProjectionOwnerDomain(workType: V9MissingDataWorkType): string {
  if (workType === "ARCHETYPE_CLASSIFICATION") return "methodology";
  if (workType === "IMPLEMENTATION_DATE" || workType === "CHAIN_SUPPLY") return "evidence";
  if (workType === "MECHANISM_REVIEW" || workType === "RESERVE_COMPOSITION" || workType === "RESERVE_SLICE") {
    return "backing";
  }
  if (workType.startsWith("EXIT_")) return "exit";
  if (workType === "PEG_INPUT") return "peg";
  if (workType === "DEPENDENCY_REVIEW") return "dependency";
  return "control";
}

function scoreProjectionTaskDigest(assetId: string, reason: ScoreProjectionReason): string {
  return createHash("sha256")
    .update(JSON.stringify({ assetId, reasonCode: reason.reasonCode, path: reason.path }))
    .digest("hex");
}

function priorityBand(critical: boolean, supplyUsd: number | null): string {
  if (critical || (supplyUsd ?? 0) >= 1_000_000_000) return "P0";
  if ((supplyUsd ?? 0) >= 100_000_000) return "P1";
  if ((supplyUsd ?? 0) >= 10_000_000) return "P2";
  return "P3";
}

function sidecarFor(source: Pick<StablecoinSourceEntry, "sidecarFiles">, domain: string): string | null {
  return source.sidecarFiles?.find((path) => path.includes(`/domains/${domain}/`)) ?? null;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

export function likelyTouchpoints(
  workType: V9MissingDataWorkType,
  source: Pick<StablecoinSourceEntry, "file" | "sidecarFiles">,
  context: unknown,
): string[] {
  const base = source.file;
  const reserve = sidecarFor(source, "reserves") ?? base;
  const mint = sidecarFor(source, "mint-authority") ?? base;
  const risk = sidecarFor(source, "risk-review") ?? base;
  switch (workType) {
    case "ACCESS_REVIEW":
    case "BRIDGE_ROUTE_REVIEW":
    case "ORACLE_BRANCH":
    case "ORACLE_PROFILE":
      return unique([risk]);
    case "ARCHETYPE_CLASSIFICATION":
    case "IMPLEMENTATION_DATE":
      return [base];
    case "BRIDGE_MATERIALITY":
      return unique([risk, base, "worker/src/lib/safety-score-v9-extension-supply.ts"]);
    case "CHAIN_SUPPLY":
      return unique([
        base,
        "worker/src/cron/snapshot-chain-supply.ts",
        "worker/src/lib/safety-score-v9-extension-supply.ts",
      ]);
    case "DEPENDENCY_REVIEW":
      return unique([reserve, base]);
    case "DEPLOYMENT_CONTROLS":
      return unique([mint, risk]);
    case "EXIT_DEX_COVERAGE":
      return ["worker/src/cron/dex-liquidity/", "worker/src/lib/safety-score-v9-extension.ts"];
    case "EXIT_OUTPUT": {
      const lane = typeof context === "object" && context !== null && "lane" in context ? context.lane : null;
      return lane === "dex"
        ? ["worker/src/lib/safety-score-v9-extension.ts"]
        : ["shared/lib/redemption-backstop-configs/"];
    }
    case "EXIT_RUNTIME_ROUTE":
      return [
        "worker/src/cron/dex-liquidity/",
        "worker/src/cron/sync-redemption-backstops.ts",
        "worker/src/lib/safety-score-v9-extension.ts",
      ];
    case "MECHANISM_REVIEW":
      return ["shared/data/safety-score-v9/mechanism-review-overlays-v1.json", base];
    case "MINT_AUTHORITY":
      return unique([mint]);
    case "PEG_INPUT":
      return unique([base, "worker/src/lib/safety-score-v9-extension.ts"]);
    case "RESERVE_COMPOSITION":
    case "RESERVE_SLICE":
      return unique([reserve]);
  }
}

function countBy<T>(values: readonly T[], keyOf: (value: T) => string): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function cardScoreProjection(card: SafetyScoreV9Card) {
  return {
    grade: card.grade,
    score: card.score,
    qualityScore: card.qualityScore,
    pegMultiplier: card.pegMultiplier,
    pegAdjustedScore: card.pegAdjustedScore,
    weakestPillar: card.weakestPillar,
    pillars: card.pillars,
    aggregateReasonCodes: card.reasonCodes,
    nrReasons: card.nrReasons,
    evidence: card.evidence,
    evidenceCaps: card.caps.filter((cap) => cap.source === "evidence"),
    bindingCap: card.bindingCap,
  };
}

export interface GenerateV9MissingDataRegistryInput {
  replay: unknown;
  policy: unknown;
  catalogEntries: StablecoinSourceEntry[];
}

export function generateV9MissingDataRegistry(input: GenerateV9MissingDataRegistryInput) {
  const replay = ReplayArtifactSchema.parse(input.replay).pipeline;
  const factSetRead = readCompiledV9FactSetForEvaluation(replay.compiledFacts);
  const facts = factSetRead.factSet;
  const queue = V9EvidenceGapQueueV2Schema.parse(
    buildV9EvidenceGapQueue({ factSet: replay.compiledFacts, policy: loadV9MethodologyPolicy(input.policy) }),
  );
  const candidate = replay.candidate;
  const candidateFactSetDigest = facts.v9FactSetDigest;
  if (
    candidate.factSetDigest !== candidateFactSetDigest ||
    candidate.baseInputGenerationId !== facts.baseInputGenerationId ||
    candidate.policy.id !== queue.policy.policyId ||
    candidate.policy.semanticDigest !== queue.policy.semanticDigest
  ) {
    throw new Error("Replay candidate, compiled facts, and policy do not share the same immutable bindings");
  }

  const factById = new Map(facts.assets.map((asset) => [asset.assetId, asset]));
  const cardById = new Map(candidate.cards.map((card) => [card.id, card]));
  const sourceById = new Map(input.catalogEntries.map((entry) => [entry.id, entry]));
  const entriesById = new Map<string, V9EvidenceGapQueueEntryV2[]>();
  for (const entry of queue.entries) {
    const existing = entriesById.get(entry.assetId) ?? [];
    existing.push(entry);
    entriesById.set(entry.assetId, existing);
  }

  const allItems: Array<{
    workType: V9MissingDataWorkType;
    resolutionMode: V9MissingDataResolutionMode;
    claimGroupId: string;
    taskSource: "compiled-fact-gap" | "score-projection-gap";
  }> = [];
  const stablecoins = facts.activeAssetIds.map((assetId) => {
    const asset = factById.get(assetId);
    const card = cardById.get(assetId);
    const source = sourceById.get(assetId);
    if (!asset || !card || !source)
      throw new Error(`Missing fact, card, or catalog source for active asset ${assetId}`);
    const openEntries = entriesById.get(assetId) ?? [];
    const supplyUsd = asset.supply.circulatingUsd;
    const factItems = openEntries.map((entry) => {
      const workType = classifyV9MissingDataWorkType(entry);
      const context = currentFactContext(entry, asset);
      const resolutionMode = resolutionModeFor(workType, entry, context);
      const claimGroupId = `${workType}:${assetId}`;
      allItems.push({ workType, resolutionMode, claimGroupId, taskSource: "compiled-fact-gap" });
      const existingEvidence = entry.evidenceRefIds.map(
        (evidenceRefId) =>
          asset.evidence.find((evidence) => evidence.evidenceId === evidenceRefId) ?? {
            evidenceId: evidenceRefId,
            unresolvedReference: true,
          },
      );
      return {
        taskSource: "compiled-fact-gap" as const,
        taskId: `V9G-${entry.queueKey.slice(0, 16)}`,
        claimGroupId,
        status: "open",
        globalPriority: entry.priority,
        priorityBand: priorityBand(entry.critical, entry.supplyWeight.canonicalUsd),
        workType,
        resolutionMode,
        recommendedEvidenceAction: evidenceAction(entry, resolutionMode),
        gapId: entry.gapId,
        queueKey: entry.queueKey,
        reasonCode: entry.reasonCode,
        message: entry.message,
        publicLabel: entry.publicLabel,
        ownerDomain: entry.ownerDomain,
        factOwnerDomain: entry.factOwnerDomain,
        policyRuleId: entry.policyRuleId,
        responsibility: entry.responsibility,
        applicability: entry.applicability,
        observationState: entry.observationState,
        path: entry.path,
        materiality: entry.materiality,
        supplyWeight: entry.supplyWeight,
        releaseSeverity: entry.releaseSeverity,
        treatment: entry.treatment,
        critical: entry.critical,
        likelyTouchpoints: likelyTouchpoints(workType, source, context),
        currentFactContext: context,
        existingEvidence,
        policyBinding: {
          queueAction: entry.action,
          issues: entry.policyBindingIssues,
          coordinatorReviewRequired: entry.policyBindingIssues.length > 0,
          note:
            entry.policyBindingIssues.length > 0
              ? "This queue-contract mismatch is separate from the evidence task; complete the recommendedEvidenceAction and route the binding issue to the v9 policy maintainer."
              : null,
        },
        doneWhenGapIdAbsent: entry.gapId,
        doneWhenScoreReasonAbsent: null,
      };
    });
    const projections = scoreProjectionReasons(card);
    const factStreams = new Set(factItems.map((item) => WORK_TYPES[item.workType].stream));
    const supplementalItems = projections
      .filter((reason) => !factStreams.has(WORK_TYPES[reason.workType].stream))
      .map((reason) => {
        const workType = reason.workType;
        const context = currentWorkTypeContext(workType, asset);
        const resolutionMode = scoreProjectionResolutionMode(workType, asset.archetype);
        // A card-aggregate reason exposes no component identity (wave-7
        // anomaly class: krwq/eur0): curation lanes cannot act on it without
        // inventing a component, so it routes to the coordinator instead.
        const componentIdentityUnavailable = reason.source === "card-aggregate" && reason.path === null;
        const claimGroupId = `${workType}:${assetId}`;
        const digest = scoreProjectionTaskDigest(assetId, reason);
        const evidenceRefIds = [...collectEvidenceRefIds(context)].sort((left, right) => left.localeCompare(right));
        const existingEvidence = evidenceRefIds.map(
          (evidenceRefId) =>
            asset.evidence.find((evidence) => evidence.evidenceId === evidenceRefId) ?? {
              evidenceId: evidenceRefId,
              unresolvedReference: true,
            },
        );
        allItems.push({ workType, resolutionMode, claimGroupId, taskSource: "score-projection-gap" });
        return {
          taskSource: "score-projection-gap" as const,
          taskId: `V9S-${digest.slice(0, 16)}`,
          claimGroupId,
          status: "open",
          globalPriority: null,
          priorityBand: priorityBand(false, supplyUsd),
          workType,
          resolutionMode,
          recommendedEvidenceAction: scoreProjectionAction(resolutionMode),
          gapId: null,
          queueKey: null,
          reasonCode: reason.reasonCode,
          message: reason.message,
          publicLabel: reason.message,
          ownerDomain: scoreProjectionOwnerDomain(workType),
          factOwnerDomain: scoreProjectionOwnerDomain(workType),
          policyRuleId: null,
          responsibility: null,
          applicability: "required",
          observationState: scoreProjectionObservationState(reason.reasonCode),
          path: { kind: "score-projection", scorePath: reason.path },
          materiality: { basis: "asset-wide", fractionOfAsset: 1 },
          supplyWeight: {
            state: supplyUsd === null ? "unavailable" : "current-valid",
            canonicalUsd: supplyUsd,
            materialityWeightedUsd: supplyUsd,
            sourceGenerationId: asset.supply.sourceGenerationId,
          },
          releaseSeverity: null,
          treatment: "score-projection",
          critical: false,
          likelyTouchpoints: likelyTouchpoints(workType, source, context),
          currentFactContext: context,
          existingEvidence,
          policyBinding: {
            queueAction: null,
            issues: [],
            coordinatorReviewRequired: componentIdentityUnavailable,
            note: componentIdentityUnavailable
              ? "Card-aggregate bounded reason without a component identity: the coordinator resolves it against the compiled facts; curation lanes must not invent a component."
              : "The score exposes this bounded reason without a corresponding compiled fact-gap row.",
          },
          doneWhenGapIdAbsent: null,
          doneWhenScoreReasonAbsent: { reasonCode: reason.reasonCode, path: reason.path },
        };
      });
    const items = [...factItems, ...supplementalItems];
    const scoreProjectionGaps = projections.map((reason) => {
      const stream = WORK_TYPES[reason.workType].stream;
      const coveredByTaskIds = items
        .filter((item) => WORK_TYPES[item.workType].stream === stream)
        .map((item) => item.taskId);
      if (coveredByTaskIds.length === 0) {
        throw new Error(`Score projection ${assetId}:${reason.reasonCode}:${reason.path ?? ""} has no agent task`);
      }
      const digest = scoreProjectionTaskDigest(assetId, reason);
      return {
        projectionId: `V9P-${digest.slice(0, 16)}`,
        source: reason.source,
        reasonCode: reason.reasonCode,
        message: reason.message,
        path: reason.path,
        workType: reason.workType,
        stream,
        coveredByTaskIds,
        requiresSupplementalTask: coveredByTaskIds.some((taskId) => taskId.startsWith("V9S-")),
      };
    });
    const claimGroups = new Set(items.map((item) => item.claimGroupId));
    const sourceFiles = [source.file, ...(source.sidecarFiles ?? [])];
    return {
      assetId,
      name: source.coin.name,
      symbol: source.coin.symbol,
      archetype: asset.archetype,
      priorityBand: priorityBand(
        items.some((item) => item.critical),
        supplyUsd,
      ),
      canonicalSupplyUsd: supplyUsd,
      sourceFiles,
      currentScore: cardScoreProjection(card),
      missingDataSummary: {
        openItemCount: items.length,
        claimGroupCount: claimGroups.size,
        criticalItemCount: items.filter((item) => item.critical).length,
        policyBindingReviewCount: items.filter((item) => item.policyBinding.coordinatorReviewRequired).length,
        workTypeCounts: countBy(items, (item) => item.workType),
        reasonCounts: countBy(items, (item) => item.reasonCode),
        resolutionModeCounts: countBy(items, (item) => item.resolutionMode),
        taskSourceCounts: countBy(items, (item) => item.taskSource),
      },
      scoreProjectionGaps,
      missingItems: items,
    };
  });

  stablecoins.sort((left, right) => {
    const critical = right.missingDataSummary.criticalItemCount - left.missingDataSummary.criticalItemCount;
    if (critical !== 0) return critical;
    const supply = (right.canonicalSupplyUsd ?? -1) - (left.canonicalSupplyUsd ?? -1);
    return supply !== 0 ? supply : left.assetId.localeCompare(right.assetId);
  });

  const registryItems = stablecoins.flatMap((asset) => asset.missingItems);
  const projectionRows = stablecoins.flatMap((asset) => asset.scoreProjectionGaps);
  const taskIds = registryItems.map((item) => item.taskId);
  if (new Set(taskIds).size !== taskIds.length) throw new Error("Generated missing-data task IDs are not unique");
  const claimGroupCount = new Set(allItems.map((item) => item.claimGroupId)).size;
  return {
    schemaVersion: 1,
    title: "Safety Score v9 missing-data registry",
    purpose: "agent-checklist-for-full-evidence-scoring",
    snapshot: {
      asOfSec: candidate.asOfSec,
      asOfIso: new Date(candidate.asOfSec * 1000).toISOString(),
      publishedAtSec: candidate.publishedAtSec,
      candidateId: candidate.candidateId,
      publicationGenerationId: candidate.publicationGenerationId,
      baseInputGenerationId: candidate.baseInputGenerationId,
      factSetDigest: candidate.factSetDigest,
      sourceFactSetSchemaVersion: factSetRead.sourceSchemaVersion,
      sourceFactSetDigest: factSetRead.sourceFactSetDigest,
      evaluationFactSetDigest: facts.v9FactSetDigest,
      resultDigest: candidate.resultDigest,
      queueDigest: queue.queueDigest,
      policyId: candidate.policy.id,
      policyDigest: candidate.policy.semanticDigest,
      evaluationBuildDigest: candidate.evaluationBuildDigest,
    },
    interpretation: {
      fullEvidenceDefinition:
        "Full evidence means a fresh exact replay has no compiled v9 fact gaps or unbacked score-projection gaps for the asset. It does not mean a score of 100 or an A grade.",
      knownRiskWarning:
        "Known centralization, weak controls, poor exit capacity, reserve risk, dependencies, short history, and peg behavior continue to reduce the score after missing data is filled.",
      taskCompleteness:
        "Every compiled fact gap is represented exactly once. Every score-visible missing or bounded reason is listed under scoreProjectionGaps; a supplemental task is added when no compiled fact task covers its workstream.",
      policyBindingWarning:
        "Policy-binding issues are queue-contract defects, not substitutes for evidence work. Each affected item preserves the defect and supplies a separate evidence action.",
      responsibilityWarning:
        "Compiled fact tasks identify whether evidence is measured adverse, issuer-undisclosed, integration-missing, producer-failed, or method-unsupported. Score-projection-only tasks carry null because they have no compiled fact-gap responsibility.",
      pointInTimeWarning:
        "This registry is bound to one immutable production replay. Regenerate it after coordinated data batches; resolved task IDs disappear and new gaps receive new IDs.",
    },
    agentProtocol: {
      claim:
        "Claim the whole claimGroupId in agents/safety-score-v9/results/curation-swarm-session-*.md before work. Do not split one asset/workType group across agents.",
      collisionAvoidance:
        "Check git status immediately before editing every likelyTouchpoint. Skip files dirty from another lane and record the unresolved task IDs.",
      evidenceStandard:
        "Use primary sources, dated reviews, named reviewers, pinned explorer/RPC observations where practical, and explicit blocked findings. Never fabricate a value to clear a gap.",
      verification:
        "Run focused schema/tests for touched sources. The coordinator regenerates the catalog, captures exact inputs, replays v9, and regenerates this registry; an item is done only when its doneWhenGapIdAbsent or doneWhenScoreReasonAbsent condition is absent.",
      editPolicy:
        "Do not hand-edit generated task status. The swarm session tracks only current ownership and unresolved handoffs; durable evidence and blockers belong in reviewed source metadata. This file is regenerated from score facts.",
    },
    summary: {
      stablecoinCount: stablecoins.length,
      affectedStablecoinCount: stablecoins.filter((asset) => asset.missingItems.length > 0).length,
      rateableStablecoinCount: candidate.cards.filter((card) => card.grade !== "NR").length,
      notRatedStablecoinCount: candidate.cards.filter((card) => card.grade === "NR").length,
      openItemCount: registryItems.length,
      compiledFactItemCount: queue.entries.length,
      supplementalScoreItemCount: registryItems.filter((item) => item.taskSource === "score-projection-gap").length,
      scoreProjectionReasonCount: projectionRows.length,
      scoreProjectionReasonNeedingSupplementCount: projectionRows.filter((row) => row.requiresSupplementalTask).length,
      claimGroupCount,
      criticalItemCount: queue.entries.filter((entry) => entry.critical).length,
      policyBindingReviewCount: registryItems.filter((item) => item.policyBinding.coordinatorReviewRequired).length,
      responsibilityCounts: queue.summary.responsibilityCounts,
      observationStateCounts: countBy(registryItems, (entry) => entry.observationState),
      gradeCounts: countBy(candidate.cards, (card) => card.grade),
      workTypeCounts: countBy(allItems, (item) => item.workType),
      reasonCounts: countBy(registryItems, (entry) => entry.reasonCode),
      resolutionModeCounts: countBy(allItems, (item) => item.resolutionMode),
      ownerDomainCounts: countBy(registryItems, (entry) => entry.ownerDomain),
      taskSourceCounts: countBy(allItems, (item) => item.taskSource),
    },
    workTypeDefinitions: WORK_TYPES,
    stablecoins,
  };
}

interface RegistryIo {
  readJson(path: string): unknown;
  writeText(path: string, contents: string): void;
  stdout: { write(text: string): unknown };
}

const DEFAULT_IO: RegistryIo = {
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  writeText: writeJsonOutput,
  stdout: process.stdout,
};

export function runV9MissingDataRegistryCli(argv: readonly string[], io: RegistryIo = DEFAULT_IO) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      replay: { type: "string" },
      policy: { type: "string" },
      output: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  const replayPath = requireCliString(values.replay, "--replay");
  const policyPath = requireCliString(values.policy, "--policy");
  const outputPath = requireCliString(values.output, "--output");

  const registry = generateV9MissingDataRegistry({
    replay: io.readJson(replayPath),
    policy: io.readJson(policyPath),
    catalogEntries: loadPerCoinStablecoinEntries(),
  });
  io.writeText(outputPath, `${JSON.stringify(registry, null, 2)}\n`);
  io.stdout.write(
    `Wrote ${registry.summary.openItemCount} missing-data items for ${registry.summary.stablecoinCount} stablecoins to ${outputPath}\n`,
  );
  return registry;
}

runDirectCli(import.meta.url, () => runV9MissingDataRegistryCli(process.argv.slice(2)), {
  label: "safety-score-v9:missing-data-registry",
  usage: USAGE,
});
