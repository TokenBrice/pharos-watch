"use client";

import Link from "next/link";
import { memo, useMemo, type ReactNode } from "react";
import {
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
} from "@shared/lib/classification";
import { MECHANISM_ARCHETYPE_SHORT_LABELS } from "@shared/lib/classification/mechanism-archetypes";
import {
  formatCurrency,
  formatBps,
  formatNativePrice,
  formatPercent,
  formatPercentFromRatio,
  formatScore,
  formatSignedCurrency,
  formatSignedPercent,
} from "@shared/lib/format";
import { GENIUS_STATUS_SHORT_LABELS } from "@shared/lib/genius";
import { MICA_STATUS_BADGE_STYLES } from "@shared/lib/mica";
import { getPegReference } from "@shared/lib/peg-rates";
import { projectTopDriver } from "@shared/lib/safety-score-v9/public";
import {
  getCirculatingRaw,
  getPrevDayRawOrNull,
  getPrevMonthRawOrNull,
  getPrevWeekRawOrNull,
} from "@shared/lib/supply";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SafetyScoreTopDriver } from "@/components/safety-score-top-driver";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { MethodologyLabel } from "@/components/methodology-hint";
import { resolveMintAuthorityStatus } from "@/lib/mint-authority-display";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { ComparisonCoinEntry } from "@/lib/compare-derive";

interface ComparisonTableProps {
  coins: ComparisonCoinEntry[];
  pegRates: Record<string, number>;
  logos?: Record<string, string>;
  detailErrors?: Record<string, boolean>;
}

interface ComparisonMetric {
  key: string;
  label: ReactNode;
  render: (coin: ComparisonCoinEntry) => ReactNode;
  numeric?: boolean;
}

interface ComparisonSection {
  key: string;
  title: string;
  description: string;
  metrics: ComparisonMetric[];
}

const NULL_VALUE = <span className="text-muted-foreground" title="No comparable data available">—</span>;

function present(value: string | number | null | undefined, fallback: ReactNode = NULL_VALUE): ReactNode {
  return value == null || value === "" ? fallback : value;
}

function humanize(value: string | null | undefined): ReactNode {
  if (value?.toLowerCase() === "nr") return "NR";
  return value ? humanizeSafetyScoreV9Value(value.replaceAll("_", "-")) : NULL_VALUE;
}

function formatComparisonBps(value: number | null | undefined): ReactNode {
  if (value == null || !Number.isFinite(value)) return NULL_VALUE;
  const rounded = Math.round(value);
  return rounded === 0
    ? `${value > 0 ? "+" : ""}${value.toFixed(0)} bps`
    : formatBps(rounded);
}

function formatScore100(value: number | null | undefined): ReactNode {
  return value == null ? NULL_VALUE : `${formatScore(value, { trimInteger: true })}/100`;
}

function formatSupplyChange(coin: ComparisonCoinEntry, previous: number | null): ReactNode {
  const current = getCirculatingRaw(coin.data);
  if (previous == null || previous <= 0) return NULL_VALUE;
  return formatSignedPercent(((current - previous) / previous) * 100);
}

function formatCount(value: number | null | undefined, singular: string, plural = `${singular}s`): ReactNode {
  if (value == null) return NULL_VALUE;
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

function formatDays(value: number | null | undefined): ReactNode {
  if (value == null) return NULL_VALUE;
  if (value >= 730) return `${(value / 365).toFixed(1)} years`;
  if (value >= 365) return `${(value / 365).toFixed(1)} year`;
  return `${Math.round(value)} days`;
}

function reserveSummary(coin: ComparisonCoinEntry): ReactNode {
  const reserves = coin.meta.reserves ?? [];
  if (reserves.length === 0) return NULL_VALUE;
  const sorted = [...reserves].sort((a, b) => b.pct - a.pct);
  const lead = sorted[0];
  return `${lead.name} ${formatPercent(lead.pct, 0)}${reserves.length > 1 ? ` · ${reserves.length} slices` : ""}`;
}

function dependencySummary(coin: ComparisonCoinEntry): ReactNode {
  const card = coin.safetyCard;
  if (!card) return NULL_VALUE;
  const dependencies = [
    ...card.dependencies.serial.map((item) => item.upstreamAssetId),
    ...card.dependencies.basket.map((item) => item.upstreamAssetId),
  ];
  if (dependencies.length === 0) return "No scored dependency";
  return dependencies.slice(0, 3).join(", ") + (dependencies.length > 3 ? ` +${dependencies.length - 3}` : "");
}

function blacklistLabel(coin: ComparisonCoinEntry): string {
  switch (coin.meta.blacklistStatus) {
    case true:
      return "Direct freeze power";
    case "inherited":
      return "Upstream freeze exposure";
    case "possible":
      return "Freeze power possible";
    case false:
      return "No known freeze power";
    default:
      return "Not reviewed";
  }
}

function safetyGradeLabel(coin: ComparisonCoinEntry): ReactNode {
  const card = coin.safetyCard;
  if (!card) return NULL_VALUE;
  return card.score == null ? card.grade : `${card.grade} · ${formatScore(card.score, { trimInteger: true })}`;
}

function buildSections(pegRates: Record<string, number>): ComparisonSection[] {
  return [
    {
      key: "overview",
      title: "Overview",
      description: "The compact substitution view: peg, scale, safety, liquidity, and design.",
      metrics: [
        {
          key: "price",
          label: "Price",
          numeric: true,
          render: (coin) => {
            const ref = getPegReference(coin.data.pegType, pegRates, coin.meta.commodityOunces);
            return formatNativePrice(coin.data.price, coin.meta.flags.pegCurrency, ref);
          },
        },
        { key: "deviation", label: "Peg deviation", numeric: true, render: (coin) => formatComparisonBps(coin.pegDetails?.currentDeviationBps) },
        { key: "peg-score", label: <MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel>, numeric: true, render: (coin) => formatScore100(coin.pegDetails?.pegScore) },
        { key: "market-cap", label: "Market cap", numeric: true, render: (coin) => formatCurrency(getCirculatingRaw(coin.data)) },
        { key: "supply-24h", label: "Supply change · 24h", numeric: true, render: (coin) => formatSupplyChange(coin, getPrevDayRawOrNull(coin.data)) },
        { key: "supply-7d", label: "Supply change · 7d", numeric: true, render: (coin) => formatSupplyChange(coin, getPrevWeekRawOrNull(coin.data)) },
        { key: "supply-30d", label: "Supply change · 30d", numeric: true, render: (coin) => formatSupplyChange(coin, getPrevMonthRawOrNull(coin.data)) },
        { key: "safety", label: <MethodologyLabel topic="safetyScore">Safety</MethodologyLabel>, numeric: true, render: safetyGradeLabel },
        { key: "liquidity", label: <MethodologyLabel topic="liquidityScore">Liquidity</MethodologyLabel>, numeric: true, render: (coin) => formatScore100(coin.liquidity?.liquidityScore) },
        {
          key: "mechanism",
          label: "Mechanism",
          render: (coin) => coin.meta.mechanismArchetype
            ? MECHANISM_ARCHETYPE_SHORT_LABELS[coin.meta.mechanismArchetype]
            : NULL_VALUE,
        },
      ],
    },
    {
      key: "peg",
      title: "Peg Track Record",
      description: "Current stress plus the reviewed observation window behind Peg Score.",
      metrics: [
        { key: "active-depeg", label: "Current state", render: (coin) => coin.pegDetails ? (coin.pegDetails.activeDepeg ? "Active depeg" : "At peg") : NULL_VALUE },
        { key: "peg-90d", label: "At peg · 90d", numeric: true, render: (coin) => coin.pegDetails?.recent90d ? formatPercent(coin.pegDetails.recent90d.pegPct) : NULL_VALUE },
        { key: "incidents-90d", label: "Incidents · 90d", numeric: true, render: (coin) => coin.pegDetails?.recent90d ? formatCount(coin.pegDetails.recent90d.incidentCount, "incident") : NULL_VALUE },
        { key: "worst-deviation", label: "Worst deviation", numeric: true, render: (coin) => formatComparisonBps(coin.pegDetails?.worstDeviationBps) },
        { key: "event-count", label: "Recorded incidents", numeric: true, render: (coin) => coin.pegDetails ? formatCount(coin.pegDetails.eventCount, "incident") : NULL_VALUE },
        { key: "tracking-span", label: "Tracking span", numeric: true, render: (coin) => formatDays(coin.pegDetails?.trackingSpanDays) },
        { key: "price-confidence", label: "Price confidence", render: (coin) => humanize(coin.pegDetails?.priceConfidence) },
        { key: "price-sources", label: "Price sources", numeric: true, render: (coin) => coin.pegDetails ? formatCount(coin.pegDetails.consensusSources?.length ?? 0, "source") : NULL_VALUE },
      ],
    },
    {
      key: "safety",
      title: "Safety Construction",
      description: "Exact V9 pillars, binding constraints, access posture, and dependency exposure.",
      metrics: [
        { key: "backing-pillar", label: "Backing pillar", numeric: true, render: (coin) => formatScore100(coin.safetyCard?.pillars.backing.score) },
        { key: "exit-pillar", label: "Exit pillar", numeric: true, render: (coin) => formatScore100(coin.safetyCard?.pillars.exit.score) },
        { key: "control-pillar", label: "Control pillar", numeric: true, render: (coin) => formatScore100(coin.safetyCard?.pillars.control.score) },
        { key: "weakest-pillar", label: "Weakest pillar", render: (coin) => coin.safetyCard?.weakestPillar ? `${humanizeSafetyScoreV9Value(coin.safetyCard.weakestPillar.pillar)} · ${formatScore(coin.safetyCard.weakestPillar.score, { trimInteger: true })}` : NULL_VALUE },
        { key: "binding-cap", label: "Binding cap", render: (coin) => coin.safetyCard ? (coin.safetyCard.bindingCap ? `${humanizeSafetyScoreV9Value(coin.safetyCard.bindingCap.kind)} · ${coin.safetyCard.bindingCap.limit}` : "None") : NULL_VALUE },
        { key: "evidence", label: "Evidence", render: (coin) => coin.safetyCard ? `${humanizeSafetyScoreV9Value(coin.safetyCard.evidence.level)} · ${humanizeSafetyScoreV9Value(coin.safetyCard.evidence.freshness)}` : NULL_VALUE },
        {
          key: "top-driver",
          label: "Top driver",
          render: (coin) => {
            if (!coin.safetyCard) return NULL_VALUE;
            const driver = projectTopDriver(coin.safetyCard);
            return driver ? (
              <SafetyScoreTopDriver driver={driver} coinId={coin.id} subjectLabel={coin.symbol} />
            ) : NULL_VALUE;
          },
        },
        { key: "primary-exit", label: "Primary exit access", render: (coin) => humanize(coin.safetyCard?.accessPosture.primaryExit) },
        { key: "freeze-exposure", label: "Freeze exposure", render: (coin) => humanize(coin.safetyCard?.accessPosture.freezeExposure) },
        { key: "dependencies", label: "Scored dependencies", render: dependencySummary },
        { key: "bluechip", label: "External Bluechip", render: (coin) => coin.bluechipRating ? `${coin.bluechipRating.grade} · ${coin.bluechipRating.smartContractAudit ? "audit recorded" : "no audit flag"}` : "Not rated" },
      ],
    },
    {
      key: "exit",
      title: "Exit & Liquidity",
      description: "Venue depth and the primary redemption route are shown separately, not blended.",
      metrics: [
        { key: "effective-tvl", label: "Effective DEX TVL", numeric: true, render: (coin) => coin.liquidity ? formatCurrency(coin.liquidity.effectiveTvlUsd) : NULL_VALUE },
        { key: "volume-24h", label: "DEX volume · 24h", numeric: true, render: (coin) => coin.liquidity ? formatCurrency(coin.liquidity.totalVolume24hUsd) : NULL_VALUE },
        { key: "venues", label: "Pools / chains", numeric: true, render: (coin) => coin.liquidity ? `${coin.liquidity.poolCount} / ${coin.liquidity.chainCount}` : NULL_VALUE },
        { key: "dex-evidence", label: "Liquidity evidence", render: (coin) => humanize(coin.liquidity?.liquidityEvidenceClass) },
        { key: "concentration", label: "Venue concentration", numeric: true, render: (coin) => coin.liquidity?.concentrationHhi != null ? formatPercent(coin.liquidity.concentrationHhi * 100, 0) : NULL_VALUE },
        { key: "redemption-score", label: "Redemption score", numeric: true, render: (coin) => formatScore100(coin.redemption?.score) },
        { key: "route-status", label: "Redemption route", render: (coin) => coin.redemption ? `${humanizeSafetyScoreV9Value(coin.redemption.routeFamily)} · ${humanizeSafetyScoreV9Value(coin.redemption.routeStatus)}` : NULL_VALUE },
        { key: "holder-access", label: "Holder eligibility", render: (coin) => humanize(coin.redemption?.holderEligibility) },
        { key: "settlement", label: "Settlement", render: (coin) => humanize(coin.redemption?.settlementModel) },
        { key: "capacity", label: "Immediate capacity", numeric: true, render: (coin) => coin.redemption?.immediateCapacityUsd != null ? formatCurrency(coin.redemption.immediateCapacityUsd) : NULL_VALUE },
        { key: "fee", label: "Redemption fee", numeric: true, render: (coin) => coin.redemption?.feeBps != null ? `${coin.redemption.feeBps.toFixed(0)} bps` : NULL_VALUE },
      ],
    },
    {
      key: "activity",
      title: "Activity & Yield",
      description: "Directional issuance and yield context; larger values are not treated as automatically better.",
      metrics: [
        { key: "dews", label: "DEWS", numeric: true, render: (coin) => coin.stress ? `${coin.stress.band} · ${formatScore(coin.stress.score, { trimInteger: true })}` : NULL_VALUE },
        { key: "pressure", label: "Pressure Shift", numeric: true, render: (coin) => coin.flow?.pressureShiftState ? `${humanizeSafetyScoreV9Value(coin.flow.pressureShiftState)}${coin.flow.pressureShiftScore != null ? ` · ${formatScore(coin.flow.pressureShiftScore, { trimInteger: true })}` : ""}` : NULL_VALUE },
        { key: "flow-24h", label: "Net flow · 24h", numeric: true, render: (coin) => coin.flow ? formatSignedCurrency(coin.flow.netFlow24hUsd) : NULL_VALUE },
        { key: "flow-7d", label: "Net flow · 7d", numeric: true, render: (coin) => coin.flow ? formatSignedCurrency(coin.flow.netFlow7dUsd) : NULL_VALUE },
        { key: "flow-30d", label: "Net flow · 30d", numeric: true, render: (coin) => coin.flow ? formatSignedCurrency(coin.flow.netFlow30dUsd) : NULL_VALUE },
        { key: "flow-90d", label: "Net flow · 90d", numeric: true, render: (coin) => coin.flow ? formatSignedCurrency(coin.flow.netFlow90dUsd) : NULL_VALUE },
        { key: "apy-30d", label: "APY · 30d", numeric: true, render: (coin) => coin.yield ? formatPercent(coin.yield.apy30d) : NULL_VALUE },
        { key: "excess-yield", label: "Excess yield", numeric: true, render: (coin) => coin.yield ? formatSignedPercent(coin.yield.excessYield) : NULL_VALUE },
        { key: "pys", label: "Pharos Yield Score", numeric: true, render: (coin) => formatScore100(coin.yield?.pharosYieldScore) },
        { key: "yield-stability", label: "Yield stability", numeric: true, render: (coin) => coin.yield?.yieldStability != null ? formatPercentFromRatio(coin.yield.yieldStability, 0) : NULL_VALUE },
        { key: "yield-source", label: "Yield source", render: (coin) => present(coin.yield?.yieldSource) },
        { key: "yield-tvl", label: "Yield source TVL", numeric: true, render: (coin) => coin.yield?.sourceTvlUsd != null ? formatCurrency(coin.yield.sourceTvlUsd) : NULL_VALUE },
      ],
    },
    {
      key: "structure",
      title: "Structure & Controls",
      description: "Curated design, custody, control, reserve, and regulatory context.",
      metrics: [
        { key: "peg-target", label: "Peg target", render: (coin) => coin.meta.flags.pegCurrency },
        { key: "backing", label: "Backing", render: (coin) => BACKING_LABELS_SHORT[coin.meta.flags.backing] ?? coin.meta.flags.backing },
        { key: "governance", label: "Governance", render: (coin) => GOVERNANCE_LABELS_SHORT[coin.meta.flags.governance] ?? coin.meta.flags.governance },
        { key: "launch", label: "Launch date", numeric: true, render: (coin) => present(coin.meta.launchDate) },
        { key: "reserves", label: "Largest reserve exposure", render: reserveSummary },
        { key: "collateral-quality", label: "Collateral quality", render: (coin) => humanize(coin.meta.collateralQuality) },
        { key: "custody", label: "Custody model", render: (coin) => humanize(coin.meta.custodyModel) },
        { key: "mint-authority", label: "Mint authority", render: (coin) => resolveMintAuthorityStatus(coin.meta.mintAuthoritySummary).spokenLabel },
        { key: "blacklist", label: "Freeze capability", render: blacklistLabel },
        { key: "variant", label: "Variant relationship", render: (coin) => coin.meta.variantOf ? `${humanizeSafetyScoreV9Value(coin.meta.variantKind ?? "variant")} of ${coin.meta.variantOf}` : "Base asset" },
        { key: "mica", label: "MiCA", render: (coin) => coin.meta.mica ? `${MICA_STATUS_BADGE_STYLES[coin.meta.mica.status].label}${coin.meta.mica.tokenType ? ` · ${coin.meta.mica.tokenType}` : ""}` : "Not researched" },
        { key: "genius", label: "GENIUS pathway", render: (coin) => coin.meta.genius ? GENIUS_STATUS_SHORT_LABELS[coin.meta.genius.authorizationStatus] : "Not researched" },
      ],
    },
  ];
}

function FrozenBadge({ frozenAt }: { frozenAt?: string }) {
  return (
    <span
      className="rounded border border-zinc-500/30 px-1 text-[9px] uppercase tracking-wide text-zinc-500"
      title={frozenAt ? `Frozen on ${frozenAt}` : "Frozen"}
    >
      Frozen
    </span>
  );
}

export const ComparisonTable = memo(function ComparisonTable({ coins, pegRates, logos, detailErrors }: ComparisonTableProps) {
  const sections = useMemo(() => buildSections(pegRates), [pegRates]);

  if (coins.length === 0) {
    return <div className="pharos-empty-note py-8 text-center">Select stablecoins above to compare them side-by-side.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="pharos-subtle-band">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="pharos-kicker">Comparison Matrix</p>
            <p className="mt-1 text-sm text-foreground">Exact values across market, risk, exit, activity, and structure.</p>
          </div>
          <p className="pharos-meta">A dash means that source has no comparable value; it is not a zero.</p>
        </div>
      </div>

      <TableFrame
        tableId="live-comparison-matrix"
        testId="live-comparison-matrix-table"
        role="region"
        aria-label="Stablecoin comparison matrix"
        tabIndex={0}
        tableAriaLabel="Stablecoin comparison matrix"
        chrome="default"
        density="compact"
      >
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="pharos-table-sticky-metric min-w-[10rem] bg-background">Metric</TableHead>
            {coins.map((coin) => (
              <TableHead scope="col" key={coin.id} className="min-w-[9.5rem] text-center align-top">
                <Link
                  href={buildStablecoinUrl(coin.id)}
                  className="pharos-focus-ring inline-flex w-full flex-col items-center gap-1 rounded-lg px-2 py-2"
                >
                  <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={28} />
                  <span className="flex items-center gap-1 text-xs font-semibold">
                    {coin.symbol}
                    {coin.meta.status === "frozen" ? <FrozenBadge frozenAt={coin.meta.frozenAt} /> : null}
                  </span>
                  <span className="max-w-[8.5rem] truncate text-xs font-normal text-muted-foreground">{coin.name}</span>
                  {detailErrors?.[coin.id] ? <span className="text-[10px] text-destructive">History unavailable</span> : null}
                </Link>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sections.map((section) => (
            <SectionRows key={section.key} section={section} coins={coins} />
          ))}
        </TableBody>
      </TableFrame>
    </div>
  );
});

function SectionRows({ section, coins }: { section: ComparisonSection; coins: ComparisonCoinEntry[] }) {
  return (
    <>
      <TableRow className="hover:bg-muted/30">
        <TableHead colSpan={coins.length + 1} className="bg-muted/35 px-3 py-3 text-left">
          <span className="block text-sm font-semibold text-foreground">{section.title}</span>
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{section.description}</span>
        </TableHead>
      </TableRow>
      {section.metrics.map((metric) => (
        <TableRow key={metric.key}>
          <TableHead scope="row" className="pharos-table-sticky-metric min-w-[10rem] bg-background font-medium text-foreground">
            {metric.label}
          </TableHead>
          {coins.map((coin) => (
            <TableCell
              key={coin.id}
              className={`max-w-[14rem] whitespace-normal text-center text-xs ${metric.numeric ? "pharos-numeric" : ""}`}
            >
              {metric.render(coin)}
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
