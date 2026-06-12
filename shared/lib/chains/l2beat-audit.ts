import type { ChainTier, ContractDeployment, DeploymentModel } from "../../types";
import { CHAIN_META } from "./index";
import {
  L2BEAT_CHAIN_ALIASES,
  L2BEAT_CHAIN_RISK_FIELD_LABELS,
  L2BEAT_CHAIN_RISK_FIELDS,
  L2BEAT_CHAIN_RISK_SNAPSHOT,
  computeL2BeatChainEnvironmentScore,
  getL2BeatSafetyScoreAudit,
  resolveL2BeatProjectId,
  type L2BeatRiskField,
  type L2BeatRiskSentiment,
  type L2BeatStage,
} from "./l2beat-risk";

type L2BeatProjectId = keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT;

const L2BEAT_HOST_CHAIN_ALIASES: Record<string, string> = {
  Ethereum: "ethereum",
  "Arbitrum One": "arbitrum",
  "Arbitrum Nova": "arbitrum",
};

export type L2BeatAliasIntegrityIssueKind =
  | "alias-chain-missing"
  | "alias-project-missing"
  | "implicit-project-match"
  | "snapshot-project-without-alias";

export interface L2BeatAliasIntegrityIssue {
  kind: L2BeatAliasIntegrityIssueKind;
  chainId?: string;
  projectId?: string;
  message: string;
}

export interface L2BeatInfrastructureContext {
  chainId: string;
  projectId: string;
  slug: string;
  name: string;
  layer: "layer2" | "layer3";
  category: string;
  hostChain: string;
  hostChainId: string | null;
  stage: L2BeatStage;
  isUnderReview: boolean;
  chainEnvironmentScore: number;
}

export interface L2BeatChainCoverageRow extends L2BeatInfrastructureContext {
  chainName: string;
  aliasStatus: "explicit" | "implicit";
  riskSentiments: Record<L2BeatRiskSentiment, number>;
}

export interface L2BeatUnmatchedChainRow {
  chainId: string;
  chainName: string;
}

export interface L2BeatChainCoverageAudit {
  generatedAt: string;
  summary: {
    pharosChainCount: number;
    matchedChainCount: number;
    unmatchedChainCount: number;
    explicitAliasCount: number;
    snapshotProjectCount: number;
    aliasIssueCount: number;
  };
  matchedChains: L2BeatChainCoverageRow[];
  unmatchedChains: L2BeatUnmatchedChainRow[];
  aliasIssues: L2BeatAliasIntegrityIssue[];
}

export type L2BeatStablecoinReviewReason =
  | "chain-tier-stage1-candidate"
  | "chain-tier-review"
  | "deployment-model-missing"
  | "deployment-model-multichain-review"
  | "layer3-host-chain-review"
  | "l2beat-under-review"
  | "weak-l2beat-chain-environment";

export interface L2BeatStablecoinMetadataInput {
  id: string;
  symbol: string;
  name?: string;
  chainTier?: ChainTier;
  deploymentModel?: DeploymentModel;
  contracts?: readonly Pick<ContractDeployment, "chain">[];
}

export interface L2BeatStablecoinReviewRow {
  coinId: string;
  symbol: string;
  name?: string;
  chainId: string;
  chainTier: ChainTier | null;
  deploymentModel: DeploymentModel | null;
  contractChainCount: number;
  projectId: string;
  l2beatName: string;
  slug: string;
  stage: L2BeatStage;
  layer: "layer2" | "layer3";
  category: string;
  hostChain: string;
  hostChainId: string | null;
  chainEnvironmentScore: number;
  suggestedChainTier: ChainTier | null;
  suggestedDeploymentModel: DeploymentModel | null;
  reasons: L2BeatStablecoinReviewReason[];
  notes: string[];
}

export interface L2BeatStablecoinSafetyAudit {
  generatedAt: string;
  summary: {
    stablecoinCount: number;
    stablecoinsWithContracts: number;
    stablecoinsWithL2BeatDeployments: number;
    matchedDeploymentCount: number;
    reviewRowCount: number;
  };
  reviewRows: L2BeatStablecoinReviewRow[];
}

function riskSentimentCounts(projectId: L2BeatProjectId): Record<L2BeatRiskSentiment, number> {
  const counts: Record<L2BeatRiskSentiment, number> = {
    good: 0,
    warning: 0,
    bad: 0,
    UnderReview: 0,
    neutral: 0,
  };
  const snapshot = L2BEAT_CHAIN_RISK_SNAPSHOT[projectId];
  for (const field of L2BEAT_CHAIN_RISK_FIELDS) {
    counts[snapshot.risks[field].sentiment] += 1;
  }
  return counts;
}

function sortRiskFields(left: L2BeatRiskField, right: L2BeatRiskField): number {
  return L2BEAT_CHAIN_RISK_FIELD_LABELS[left].localeCompare(L2BEAT_CHAIN_RISK_FIELD_LABELS[right]);
}

function weakestRiskNotes(projectId: L2BeatProjectId): string[] {
  const snapshot = L2BEAT_CHAIN_RISK_SNAPSHOT[projectId];
  return [...L2BEAT_CHAIN_RISK_FIELDS]
    .sort(sortRiskFields)
    .filter((field) => {
      const sentiment = snapshot.risks[field].sentiment;
      return sentiment === "bad" || sentiment === "warning" || sentiment === "UnderReview";
    })
    .map((field) => {
      const risk = snapshot.risks[field];
      return `${L2BEAT_CHAIN_RISK_FIELD_LABELS[field]}: ${risk.value} (${risk.sentiment})`;
    });
}

function hostChainId(hostChain: string): string | null {
  return L2BEAT_HOST_CHAIN_ALIASES[hostChain] ?? null;
}

export function getL2BeatInfrastructureContext(chainId: string): L2BeatInfrastructureContext | null {
  const projectId = resolveL2BeatProjectId(chainId);
  if (!projectId) return null;

  const snapshot = L2BEAT_CHAIN_RISK_SNAPSHOT[projectId];
  return {
    chainId,
    projectId,
    slug: snapshot.slug,
    name: snapshot.name,
    layer: snapshot.type,
    category: snapshot.category,
    hostChain: snapshot.hostChain,
    hostChainId: hostChainId(snapshot.hostChain),
    stage: snapshot.stage,
    isUnderReview: snapshot.isUnderReview,
    chainEnvironmentScore: computeL2BeatChainEnvironmentScore(snapshot),
  };
}

export function findL2BeatAliasIntegrityIssues(
  chainIds: readonly string[] = Object.keys(CHAIN_META),
): L2BeatAliasIntegrityIssue[] {
  const chainIdSet = new Set(chainIds);
  const issues: L2BeatAliasIntegrityIssue[] = [];
  const aliasedProjectIds = new Set<string>();

  for (const [chainId, projectId] of Object.entries(L2BEAT_CHAIN_ALIASES)) {
    aliasedProjectIds.add(projectId);
    if (!chainIdSet.has(chainId)) {
      issues.push({
        kind: "alias-chain-missing",
        chainId,
        projectId,
        message: `L2BEAT alias references unknown Pharos chain '${chainId}'.`,
      });
    }
    if (!(projectId in L2BEAT_CHAIN_RISK_SNAPSHOT)) {
      issues.push({
        kind: "alias-project-missing",
        chainId,
        projectId,
        message: `L2BEAT alias '${chainId}' references missing snapshot project '${projectId}'.`,
      });
    }
  }

  for (const chainId of chainIds) {
    const projectId = resolveL2BeatProjectId(chainId);
    if (projectId && !(chainId in L2BEAT_CHAIN_ALIASES)) {
      issues.push({
        kind: "implicit-project-match",
        chainId,
        projectId,
        message: `Pharos chain '${chainId}' matches L2BEAT project '${projectId}' without an explicit alias.`,
      });
    }
  }

  for (const projectId of Object.keys(L2BEAT_CHAIN_RISK_SNAPSHOT)) {
    if (!aliasedProjectIds.has(projectId)) {
      issues.push({
        kind: "snapshot-project-without-alias",
        projectId,
        message: `L2BEAT snapshot project '${projectId}' is not reachable from an explicit Pharos chain alias.`,
      });
    }
  }

  return issues.sort((left, right) => (
    left.kind.localeCompare(right.kind) ||
    (left.chainId ?? "").localeCompare(right.chainId ?? "") ||
    (left.projectId ?? "").localeCompare(right.projectId ?? "")
  ));
}

export function buildL2BeatChainCoverageAudit(options: {
  chainIds?: readonly string[];
  generatedAt?: string;
} = {}): L2BeatChainCoverageAudit {
  const chainIds = options.chainIds ?? Object.keys(CHAIN_META);
  const matchedChains: L2BeatChainCoverageRow[] = [];
  const unmatchedChains: L2BeatUnmatchedChainRow[] = [];

  for (const chainId of chainIds) {
    const meta = CHAIN_META[chainId];
    if (!meta) continue;

    const context = getL2BeatInfrastructureContext(chainId);
    if (!context) {
      unmatchedChains.push({ chainId, chainName: meta.name });
      continue;
    }

    matchedChains.push({
      ...context,
      chainName: meta.name,
      aliasStatus: chainId in L2BEAT_CHAIN_ALIASES ? "explicit" : "implicit",
      riskSentiments: riskSentimentCounts(context.projectId as L2BeatProjectId),
    });
  }

  matchedChains.sort((left, right) => (
    left.chainEnvironmentScore - right.chainEnvironmentScore ||
    left.chainId.localeCompare(right.chainId)
  ));
  unmatchedChains.sort((left, right) => left.chainId.localeCompare(right.chainId));

  const aliasIssues = findL2BeatAliasIntegrityIssues(chainIds);

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    summary: {
      pharosChainCount: chainIds.length,
      matchedChainCount: matchedChains.length,
      unmatchedChainCount: unmatchedChains.length,
      explicitAliasCount: Object.keys(L2BEAT_CHAIN_ALIASES).length,
      snapshotProjectCount: Object.keys(L2BEAT_CHAIN_RISK_SNAPSHOT).length,
      aliasIssueCount: aliasIssues.length,
    },
    matchedChains,
    unmatchedChains,
    aliasIssues,
  };
}

function uniqueContractChains(coin: L2BeatStablecoinMetadataInput): string[] {
  return [...new Set((coin.contracts ?? []).map((contract) => contract.chain).filter(Boolean))].sort();
}

function isStage1Candidate(audits: NonNullable<ReturnType<typeof getL2BeatSafetyScoreAudit>>[]): boolean {
  return audits.length > 0 && audits.every((audit) => audit.suggestedChainTier === "stage1-l2");
}

function hasWeakRiskSentiment(projectId: L2BeatProjectId): boolean {
  const counts = riskSentimentCounts(projectId);
  if (counts.bad >= 3) return true;
  return counts.bad + counts.warning >= 4;
}

function reviewReasons(input: {
  coin: L2BeatStablecoinMetadataInput;
  chainId: string;
  contractChains: readonly string[];
  auditsForCoin: NonNullable<ReturnType<typeof getL2BeatSafetyScoreAudit>>[];
  audit: NonNullable<ReturnType<typeof getL2BeatSafetyScoreAudit>>;
  context: L2BeatInfrastructureContext;
}): L2BeatStablecoinReviewReason[] {
  const reasons = new Set<L2BeatStablecoinReviewReason>();
  const hasEthereumDeployment = input.contractChains.includes("ethereum");
  const l2beatMatchedChainCount = input.auditsForCoin.length;
  const allKnownContractChainsMatched = l2beatMatchedChainCount === input.contractChains.length;

  if (
    !hasEthereumDeployment &&
    allKnownContractChainsMatched &&
    isStage1Candidate(input.auditsForCoin)
  ) {
    if (!input.coin.chainTier) {
      reasons.add("chain-tier-stage1-candidate");
    } else if (input.coin.chainTier !== "stage1-l2") {
      reasons.add("chain-tier-review");
    }
  }

  if (input.contractChains.length > 1 && !input.coin.deploymentModel) {
    reasons.add("deployment-model-missing");
  }
  if (input.contractChains.length > 1 && input.coin.deploymentModel === "single-chain") {
    reasons.add("deployment-model-multichain-review");
  }

  if (input.context.layer === "layer3" || input.context.hostChainId !== "ethereum") {
    reasons.add("layer3-host-chain-review");
  }
  if (input.audit.notes.some((note) => note.includes("under review"))) {
    reasons.add("l2beat-under-review");
  }
  if (input.context.chainEnvironmentScore < 60 || hasWeakRiskSentiment(input.context.projectId as L2BeatProjectId)) {
    reasons.add("weak-l2beat-chain-environment");
  }

  return [...reasons].sort();
}

export function buildL2BeatStablecoinSafetyAudit(options: {
  stablecoins: readonly L2BeatStablecoinMetadataInput[];
  generatedAt?: string;
}): L2BeatStablecoinSafetyAudit {
  const reviewRows: L2BeatStablecoinReviewRow[] = [];
  let stablecoinsWithContracts = 0;
  const stablecoinsWithL2BeatDeployments = new Set<string>();
  let matchedDeploymentCount = 0;

  for (const coin of options.stablecoins) {
    const contractChains = uniqueContractChains(coin);
    if (contractChains.length > 0) stablecoinsWithContracts += 1;

    const auditsForCoin = contractChains.flatMap((chainId) => {
      const audit = getL2BeatSafetyScoreAudit(chainId);
      return audit ? [audit] : [];
    });
    if (auditsForCoin.length > 0) stablecoinsWithL2BeatDeployments.add(coin.id);

    for (const chainId of contractChains) {
      const audit = getL2BeatSafetyScoreAudit(chainId);
      const context = getL2BeatInfrastructureContext(chainId);
      if (!audit || !context) continue;
      matchedDeploymentCount += 1;

      const reasons = reviewReasons({
        coin,
        chainId,
        contractChains,
        auditsForCoin,
        audit,
        context,
      });
      if (reasons.length === 0) continue;

      reviewRows.push({
        coinId: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        chainId,
        chainTier: coin.chainTier ?? null,
        deploymentModel: coin.deploymentModel ?? null,
        contractChainCount: contractChains.length,
        projectId: audit.projectId,
        l2beatName: audit.name,
        slug: audit.slug,
        stage: audit.stage,
        layer: context.layer,
        category: audit.category,
        hostChain: audit.hostChain,
        hostChainId: context.hostChainId,
        chainEnvironmentScore: audit.chainEnvironmentScore,
        suggestedChainTier: audit.suggestedChainTier,
        suggestedDeploymentModel: audit.suggestedDeploymentModel,
        reasons,
        notes: [...audit.notes, ...weakestRiskNotes(context.projectId as L2BeatProjectId)],
      });
    }
  }

  reviewRows.sort((left, right) => (
    left.chainEnvironmentScore - right.chainEnvironmentScore ||
    left.coinId.localeCompare(right.coinId) ||
    left.chainId.localeCompare(right.chainId)
  ));

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    summary: {
      stablecoinCount: options.stablecoins.length,
      stablecoinsWithContracts,
      stablecoinsWithL2BeatDeployments: stablecoinsWithL2BeatDeployments.size,
      matchedDeploymentCount,
      reviewRowCount: reviewRows.length,
    },
    reviewRows,
  };
}
