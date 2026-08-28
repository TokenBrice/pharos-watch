import type { BridgeRouteRiskTier, StablecoinMeta } from "../../types";
import { CHAIN_META } from "./index";
import {
  L2BEAT_INTEROP_SNAPSHOT_META,
  L2BEAT_INTEROP_PROTOCOLS,
  findL2BeatInteropProtocolReferences,
  suggestBridgeRouteRiskTierFromL2BeatProtocol,
  type L2BeatInteropProtocolSnapshot,
} from "./l2beat-interop";
import {
  L2BEAT_CHAIN_ALIASES,
  L2BEAT_CHAIN_RISK_FIELDS,
  L2BEAT_CHAIN_RISK_SNAPSHOT,
  computeL2BeatChainEnvironmentScore,
  resolveL2BeatProjectId,
  type L2BeatRiskSentiment,
  type L2BeatStage,
} from "./l2beat-risk";

type L2BeatProjectId = keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT;

const BRIDGE_ROUTE_RISK_RANK: Record<BridgeRouteRiskTier, number> = {
  "single-chain-or-native": 100,
  "issuer-native-burn-mint": 90,
  "canonical-rollup-bridge": 85,
  "issuer-native-lock-mint": 80,
  "external-validated-network": 65,
  "liquidity-or-intent-route": 55,
  "external-lock-mint": 40,
  "opaque-or-unknown": 20,
};

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
  projectId: L2BeatProjectId;
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

export type L2BeatBridgeRouteReviewReason =
  | "l2beat-protocol-reference"
  | "bridge-route-risk-missing"
  | "external-protocol-route-review"
  | "reviewed-route-weaker-than-l2beat-protocols"
  | "legacy-l2beat-bridge-source";

export interface L2BeatBridgeRouteReviewRow {
  coinId: string;
  symbol: string;
  name?: string;
  currentBridgeRouteTier: BridgeRouteRiskTier | null;
  suggestedBridgeRouteTier: BridgeRouteRiskTier | null;
  protocols: Array<{
    id: string;
    slug: string;
    name: string;
    type: L2BeatInteropProtocolSnapshot["type"];
    bridgeTypes: readonly string[];
    suggestedTier: BridgeRouteRiskTier;
    url: string;
  }>;
  reasons: L2BeatBridgeRouteReviewReason[];
  notes: string[];
}

export interface L2BeatBridgeRouteReviewAudit {
  generatedAt: string;
  summary: {
    stablecoinCount: number;
    l2beatInteropProtocolCount: number;
    protocolReferenceCount: number;
    stablecoinsWithProtocolReferences: number;
    stablecoinsWithBridgeRouteRisk: number;
    reviewRowCount: number;
  };
  reviewRows: L2BeatBridgeRouteReviewRow[];
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

function findL2BeatAliasIntegrityIssues(
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
      riskSentiments: riskSentimentCounts(context.projectId),
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

function stablecoinRouteSearchText(coin: StablecoinMeta): string {
  const pieces: string[] = [
    coin.id,
    coin.symbol,
    coin.name,
    coin.oneLiner,
    coin.collateral,
    coin.pegMechanism,
    coin.bridgeRouteRisk?.summary,
  ].filter((value): value is string => typeof value === "string");

  for (const link of coin.links ?? []) {
    pieces.push(link.label, link.url);
  }
  for (const notice of coin.notices ?? []) {
    pieces.push(notice.title, notice.message);
  }
  if (coin.mintAuthority) {
    pieces.push(
      coin.mintAuthority.mintPath,
      coin.mintAuthority.summary,
      coin.mintAuthority.review.evidence,
      ...(coin.mintAuthority.review.sources ?? []).flatMap((source) => [source.label, source.url]),
    );
    for (const control of coin.mintAuthority.controls ?? []) {
      pieces.push(
        control.label,
        control.role,
        control.authorityType,
        control.evidence ?? "",
        ...(control.sources ?? []).flatMap((source) => [source.label, source.url]),
      );
    }
  }
  for (const protocol of coin.bridgeRouteRisk?.protocols ?? []) {
    pieces.push(protocol.name, protocol.slug ?? "", protocol.url ?? "", protocol.note ?? "");
  }
  for (const source of coin.bridgeRouteRisk?.sources ?? []) {
    pieces.push(source.label, source.url);
  }

  return pieces.join("\n");
}

function weakestSuggestedBridgeTier(protocols: readonly L2BeatInteropProtocolSnapshot[]): BridgeRouteRiskTier | null {
  let weakest: BridgeRouteRiskTier | null = null;
  for (const protocol of protocols) {
    const tier = suggestBridgeRouteRiskTierFromL2BeatProtocol(protocol);
    if (!weakest || BRIDGE_ROUTE_RISK_RANK[tier] < BRIDGE_ROUTE_RISK_RANK[weakest]) weakest = tier;
  }
  return weakest;
}

function bridgeRouteReviewReasons(input: {
  coin: StablecoinMeta;
  protocols: readonly L2BeatInteropProtocolSnapshot[];
  searchText: string;
}): L2BeatBridgeRouteReviewReason[] {
  const reasons = new Set<L2BeatBridgeRouteReviewReason>();
  const currentTier = input.coin.bridgeRouteRisk?.tier ?? null;
  const hasProtocolReference = input.protocols.length > 0;
  const hasLegacyBridgeSource = input.searchText.includes("l2beat.com/bridges/");
  const externalProtocol = input.protocols.some((protocol) => protocol.type !== "canonical");

  if (hasProtocolReference) reasons.add("l2beat-protocol-reference");
  if (hasProtocolReference && !currentTier) {
    reasons.add("bridge-route-risk-missing");
  }
  if (externalProtocol) {
    reasons.add("external-protocol-route-review");
  }
  if (
    currentTier &&
    externalProtocol &&
    (currentTier === "external-lock-mint" ||
      currentTier === "liquidity-or-intent-route" ||
      currentTier === "opaque-or-unknown")
  ) {
    reasons.add("reviewed-route-weaker-than-l2beat-protocols");
  }
  if (hasLegacyBridgeSource) reasons.add("legacy-l2beat-bridge-source");

  return [...reasons].sort();
}

export function buildL2BeatBridgeRouteReviewAudit(options: {
  stablecoins: readonly StablecoinMeta[];
  generatedAt?: string;
}): L2BeatBridgeRouteReviewAudit {
  const reviewRows: L2BeatBridgeRouteReviewRow[] = [];
  let protocolReferenceCount = 0;
  const stablecoinsWithProtocolReferences = new Set<string>();
  const stablecoinsWithBridgeRouteRisk = new Set<string>();

  for (const coin of options.stablecoins) {
    if (coin.bridgeRouteRisk) stablecoinsWithBridgeRouteRisk.add(coin.id);
    const searchText = stablecoinRouteSearchText(coin);
    const protocols = findL2BeatInteropProtocolReferences(searchText);
    protocolReferenceCount += protocols.length;
    if (protocols.length > 0) stablecoinsWithProtocolReferences.add(coin.id);
    const suggestedTier = weakestSuggestedBridgeTier(protocols);
    const reasons = bridgeRouteReviewReasons({ coin, protocols, searchText });
    if (reasons.length === 0) continue;

    reviewRows.push({
      coinId: coin.id,
      symbol: coin.symbol,
      name: coin.name,
      currentBridgeRouteTier: coin.bridgeRouteRisk?.tier ?? null,
      suggestedBridgeRouteTier: suggestedTier,
      protocols: protocols.map((protocol) => ({
        id: protocol.id,
        slug: protocol.slug,
        name: protocol.name,
        type: protocol.type,
        bridgeTypes: protocol.bridgeTypes,
        suggestedTier: suggestBridgeRouteRiskTierFromL2BeatProtocol(protocol),
        url: `https://l2beat.com/interop/protocols/${protocol.slug}`,
      })),
      reasons,
      notes: [
        "Reviewed bridgeRouteRisk can affect Safety Score v8.12; this queue only proposes review targets.",
        protocols.length > 0
          ? `L2BEAT Interop snapshot ${L2BEAT_INTEROP_SNAPSHOT_META.fetchedAt} matched ${protocols.length} protocol reference(s).`
          : "No L2BEAT Interop protocol reference found; the legacy bridge source still implies bridge-route review.",
      ],
    });
  }

  reviewRows.sort((left, right) => (
    (left.currentBridgeRouteTier ? 1 : 0) - (right.currentBridgeRouteTier ? 1 : 0) ||
    left.coinId.localeCompare(right.coinId)
  ));

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    summary: {
      stablecoinCount: options.stablecoins.length,
      l2beatInteropProtocolCount: L2BEAT_INTEROP_PROTOCOLS.length,
      protocolReferenceCount,
      stablecoinsWithProtocolReferences: stablecoinsWithProtocolReferences.size,
      stablecoinsWithBridgeRouteRisk: stablecoinsWithBridgeRouteRisk.size,
      reviewRowCount: reviewRows.length,
    },
    reviewRows,
  };
}
