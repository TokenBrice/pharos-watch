import {
  CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS,
  CLIENT_TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins/client-registry";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import {
  CUSTODY_MODEL_LABELS,
  GOVERNANCE_LABELS,
  PEG_METADATA,
} from "@shared/lib/classification";
import { resolveCustodyModel } from "@shared/lib/report-card-policy";
import type { PortfolioHolding } from "@/lib/portfolio-codec";
import type { V9PortfolioProjection } from "@/lib/safety-score-v9-consumers";
import type { CoinState } from "@shared/lib/coin-state";
import { formatDecimal } from "@shared/lib/format";

export const PORTFOLIO_COIN_OPTIONS = ACTIVE_STABLECOINS.map((stablecoin) => ({
  id: stablecoin.id,
  name: stablecoin.name,
  symbol: stablecoin.symbol,
}));

export const PORTFOLIO_COIN_OPTION_IDS: ReadonlySet<string> = new Set(
  PORTFOLIO_COIN_OPTIONS.map((coin) => coin.id),
);

export function formatUsd(value: number): string {
  return `$${formatDecimal(value, 0, 2)}`;
}

function isDigitString(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    if (char < "0" || char > "9") return false;
  }
  return true;
}

function isPlainDecimal(value: string): boolean {
  let hasDigit = false;
  let seenDecimal = false;

  for (const char of value) {
    if (char >= "0" && char <= "9") {
      hasDigit = true;
      continue;
    }
    if (char === "." && !seenDecimal) {
      seenDecimal = true;
      continue;
    }
    return false;
  }

  return hasDigit;
}

function isGroupedDecimal(value: string): boolean {
  const parts = value.split(".");
  if (parts.length > 2) return false;
  const [integerPart, fractionPart] = parts;
  if (!integerPart) return false;
  if (fractionPart !== undefined && fractionPart !== "" && !isDigitString(fractionPart)) {
    return false;
  }

  const groups = integerPart.split(",");
  if (groups.length < 2) return false;
  if (groups[0].length < 1 || groups[0].length > 3 || !isDigitString(groups[0])) {
    return false;
  }

  return groups.slice(1).every((group) => group.length === 3 && isDigitString(group));
}

export function parseUsdInput(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;

  const withoutCurrency = trimmed.startsWith("$") ? trimmed.slice(1).trimStart() : trimmed;
  if (!isPlainDecimal(withoutCurrency) && !isGroupedDecimal(withoutCurrency)) {
    return 0;
  }

  const num = Number(withoutCurrency.replaceAll(",", ""));
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

export function buildHeldCardIds(holdings: readonly PortfolioHolding[]): Set<string> {
  return new Set(holdings.map((holding) => holding.coinId));
}

export interface ExceptionalHolding {
  coinId: string;
  amount: number;
  states: readonly CoinState[];
}

/** Holdings in an exceptional state (`useCoinStates`), largest entered exposure first. */
export function rankExceptionalHoldings(
  holdings: readonly PortfolioHolding[],
  statesById: ReadonlyMap<string, readonly CoinState[]>,
): ExceptionalHolding[] {
  return holdings
    .flatMap((holding) => {
      const states = statesById.get(holding.coinId);
      return states?.length ? [{ coinId: holding.coinId, amount: holding.amount, states }] : [];
    })
    .sort((left, right) => right.amount - left.amount);
}

export type DependencyExposureRoute = V9PortfolioProjection["dependencyExposure"][number];

export interface UpstreamExposureContributor {
  dependentAssetId: string;
  kind: DependencyExposureRoute["kind"];
  materiality: DependencyExposureRoute["materiality"];
  exposureUsd: number | null;
}

export interface GroupedUpstreamExposure {
  upstreamAssetId: string;
  /** Sum of measured route exposure; null when every route for this upstream coin has unknown share (R1). */
  knownExposureUsd: number | null;
  /** Known USD exposure as % of entered portfolio book; null when knownExposureUsd is null or totalUsd <= 0. */
  pctOfPortfolio: number | null;
  unknownRouteCount: number;
  hasUnknownShareRoutes: boolean;
  routeCount: number;
  contributors: UpstreamExposureContributor[];
}

/**
 * Group `buildV9PortfolioProjection().dependencyExposure` by upstream coin.
 * Preserves R1: unknown basket shares remain `null` and are counted separately
 * instead of being coerced to `$0`.
 */
export function groupDependencyExposure(
  routes: readonly DependencyExposureRoute[],
  totalPortfolioUsd: number,
): GroupedUpstreamExposure[] {
  const byUpstream = new Map<
    string,
    {
      knownSum: number;
      knownCount: number;
      unknownRouteCount: number;
      contributors: UpstreamExposureContributor[];
    }
  >();

  for (const route of routes) {
    let bucket = byUpstream.get(route.upstreamAssetId);
    if (!bucket) {
      bucket = { knownSum: 0, knownCount: 0, unknownRouteCount: 0, contributors: [] };
      byUpstream.set(route.upstreamAssetId, bucket);
    }
    if (route.exposureUsd === null) {
      bucket.unknownRouteCount += 1;
    } else {
      bucket.knownSum += route.exposureUsd;
      bucket.knownCount += 1;
    }
    bucket.contributors.push({
      dependentAssetId: route.dependentAssetId,
      kind: route.kind,
      materiality: route.materiality,
      exposureUsd: route.exposureUsd,
    });
  }

  return Array.from(byUpstream.entries())
    .map(([upstreamAssetId, bucket]): GroupedUpstreamExposure => {
      const knownExposureUsd = bucket.knownCount > 0 ? bucket.knownSum : null;
      const pctOfPortfolio =
        knownExposureUsd !== null && totalPortfolioUsd > 0
          ? (knownExposureUsd / totalPortfolioUsd) * 100
          : null;
      const sortedContributors = [...bucket.contributors].sort((left, right) => {
        if (left.exposureUsd === null && right.exposureUsd === null) {
          return left.dependentAssetId.localeCompare(right.dependentAssetId);
        }
        if (left.exposureUsd === null) return 1;
        if (right.exposureUsd === null) return -1;
        return right.exposureUsd - left.exposureUsd || left.dependentAssetId.localeCompare(right.dependentAssetId);
      });
      return {
        upstreamAssetId,
        knownExposureUsd,
        pctOfPortfolio,
        unknownRouteCount: bucket.unknownRouteCount,
        hasUnknownShareRoutes: bucket.unknownRouteCount > 0,
        routeCount: bucket.contributors.length,
        contributors: sortedContributors,
      };
    })
    .sort((left, right) => {
      if (left.knownExposureUsd === null && right.knownExposureUsd === null) {
        return left.upstreamAssetId.localeCompare(right.upstreamAssetId);
      }
      if (left.knownExposureUsd === null) return 1;
      if (right.knownExposureUsd === null) return -1;
      return right.knownExposureUsd - left.knownExposureUsd || left.upstreamAssetId.localeCompare(right.upstreamAssetId);
    });
}

export type ConcentrationTone =
  | "danger"
  | "warn"
  | "info"
  | "positive"
  | "series-blue"
  | "series-green"
  | "series-amber"
  | "series-cyan"
  | "series-slate";

export interface PortfolioConcentrationBucket {
  key: string;
  label: string;
  amountUsd: number;
  sharePct: number;
  tone: ConcentrationTone;
  coinIds: string[];
}

export interface PortfolioConcentrationStrip {
  id: "freeze" | "governance" | "custody" | "peg";
  title: string;
  totalUsd: number;
  knownUsd: number;
  unavailableUsd: number;
  unavailableSharePct: number;
  unavailableIds: string[];
  buckets: PortfolioConcentrationBucket[];
}

const SERIES_TONES: readonly ConcentrationTone[] = [
  "series-blue",
  "series-green",
  "series-amber",
  "series-cyan",
  "series-slate",
];

function buildConcentrationStrip(
  id: PortfolioConcentrationStrip["id"],
  title: string,
  positiveHoldings: readonly PortfolioHolding[],
  totalUsd: number,
  classify: (coinId: string) => { key: string; label: string; tone?: ConcentrationTone } | null,
): PortfolioConcentrationStrip {
  const map = new Map<string, { label: string; amountUsd: number; tone?: ConcentrationTone; coinIds: string[] }>();
  let knownUsd = 0;
  let unavailableUsd = 0;
  const unavailableIds: string[] = [];

  for (const holding of positiveHoldings) {
    const resolved = classify(holding.coinId);
    if (!resolved) {
      unavailableUsd += holding.amount;
      unavailableIds.push(holding.coinId);
      continue;
    }
    knownUsd += holding.amount;
    const existing = map.get(resolved.key);
    if (existing) {
      existing.amountUsd += holding.amount;
      existing.coinIds.push(holding.coinId);
    } else {
      map.set(resolved.key, {
        label: resolved.label,
        amountUsd: holding.amount,
        tone: resolved.tone,
        coinIds: [holding.coinId],
      });
    }
  }

  const sorted = Array.from(map.entries()).sort(
    ([leftKey, left], [rightKey, right]) => right.amountUsd - left.amountUsd || leftKey.localeCompare(rightKey),
  );

  const buckets: PortfolioConcentrationBucket[] = sorted.map(([key, entry], index) => ({
    key,
    label: entry.label,
    amountUsd: entry.amountUsd,
    sharePct: (entry.amountUsd / totalUsd) * 100,
    tone: entry.tone ?? SERIES_TONES[index % SERIES_TONES.length]!,
    coinIds: entry.coinIds,
  }));

  return {
    id,
    title,
    totalUsd,
    knownUsd,
    unavailableUsd,
    unavailableSharePct: (unavailableUsd / totalUsd) * 100,
    unavailableIds,
    buckets,
  };
}

/**
 * Client-computed portfolio concentration strips for Freeze, Governance,
 * Custody, and Peg. Preserves R1–R8: unreviewed freeze status or `"unknown"`
 * custody stay explicitly disclosed in `unavailableUsd`/`unavailableIds`,
 * never coerced to zero or folded into a known bucket.
 */
export function computePortfolioConcentrations(
  holdings: readonly PortfolioHolding[],
): PortfolioConcentrationStrip[] {
  const positiveHoldings = holdings.filter((holding) => holding.amount > 0);
  const totalUsd = positiveHoldings.reduce((sum, holding) => sum + holding.amount, 0);
  if (totalUsd <= 0) return [];

  const freeze = buildConcentrationStrip("freeze", "Freeze exposure", positiveHoldings, totalUsd, (coinId) => {
    const status = getResolvedBlacklistStatus(coinId);
    if (status === true) return { key: "direct", label: "Direct freeze", tone: "danger" };
    if (status === "inherited") return { key: "upstream", label: "Upstream exposure", tone: "warn" };
    if (status === "possible") return { key: "possible", label: "Possible controls", tone: "info" };
    if (status === false) return { key: "unfreezable", label: "Unfreezable", tone: "positive" };
    return null;
  });

  const governance = buildConcentrationStrip("governance", "Governance", positiveHoldings, totalUsd, (coinId) => {
    const meta = CLIENT_TRACKED_META_BY_ID.get(coinId);
    if (!meta) return null;
    const gov = meta.flags.governance;
    const tone: ConcentrationTone =
      gov === "decentralized" ? "series-green" : gov === "centralized-dependent" ? "series-amber" : "series-blue";
    return { key: gov, label: GOVERNANCE_LABELS[gov] ?? gov, tone };
  });

  const custody = buildConcentrationStrip("custody", "Custody", positiveHoldings, totalUsd, (coinId) => {
    const meta = CLIENT_TRACKED_META_BY_ID.get(coinId);
    if (!meta) return null;
    const model = resolveCustodyModel(meta);
    if (model === "unknown") return null;
    const tone: ConcentrationTone =
      model === "onchain" ? "series-green" : model === "institutional-regulated" ? "series-blue" : "series-amber";
    return { key: model, label: CUSTODY_MODEL_LABELS[model] ?? model, tone };
  });

  const peg = buildConcentrationStrip("peg", "Peg", positiveHoldings, totalUsd, (coinId) => {
    const meta = CLIENT_TRACKED_META_BY_ID.get(coinId);
    if (!meta) return null;
    const pegCurrency = meta.flags.pegCurrency;
    return {
      key: pegCurrency,
      label: PEG_METADATA[pegCurrency]?.filterLabel ?? pegCurrency,
    };
  });

  return [freeze, governance, custody, peg];
}
