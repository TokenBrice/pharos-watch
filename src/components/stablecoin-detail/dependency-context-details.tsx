"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { DEPENDENCY_ROLE_LABELS } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { ReportCardGrade } from "@shared/types/report-card-grade";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import {
  DependencyRow,
  dependencyEntryShare,
  dependencyRoleDetail,
  dependencyRowAriaLabel,
  type PublishedCollateralUsageEntry,
} from "./collateral-usage-section";
import { formatDependencyShare, groupCoverageByReason, type DetailDependencyContext } from "./dependency-context-model";
import { ShowAllToggle } from "./disclosure-toggles";
import { DETAIL_MODULE_TITLE_CLASS } from "./section-title-class";

const PREVIEW_COUNT = 6;

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function isoDate(epochSec: number | null): string | null {
  return epochSec === null ? null : new Date(epochSec * 1000).toISOString().slice(0, 10);
}

function ListHeading({ title, count, caption }: { title: string; count?: number; caption?: string }) {
  return (
    <div className="space-y-0.5">
      <h3 className={DETAIL_MODULE_TITLE_CLASS}>
        {title}
        {count === undefined ? null : <span className="ml-1.5 font-mono font-normal tabular-nums">{count}</span>}
      </h3>
      {caption ? <p className="text-xs text-muted-foreground">{caption}</p> : null}
    </div>
  );
}

function CappedList<T>({ items, render, noun }: { items: readonly T[]; render: (item: T) => ReactNode; noun: string }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <>
      {/* -mx-2: the rows' hover fill bleeds while their content keeps the card's text edge. */}
      <ul className="-mx-2 space-y-0.5">{(showAll ? items : items.slice(0, PREVIEW_COUNT)).map(render)}</ul>
      {items.length > PREVIEW_COUNT ? (
        <ShowAllToggle
          open={showAll}
          onToggle={() => setShowAll((prev) => !prev)}
          total={items.length}
          noun={noun}
          className="-ml-2.5"
        />
      ) : null}
    </>
  );
}

/** One track per cell (up to three), so two cells spread across the module instead of filling its left 40%. */
const SUMMARY_COLUMNS_CLASS: Readonly<Record<number, string>> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
};

interface SummaryCell {
  key: string;
  label: string;
  value: string | null;
  sub: ReactNode;
}

/** How each relationship reads in the dependents breakdown ("46 as collateral · 35 wrappers"). */
const RELATIONSHIP_BREAKDOWN: Readonly<Record<PublishedCollateralUsageEntry["relationshipType"], (count: number) => string>> = {
  collateral: (count) => `${count} as collateral`,
  wrapper: (count) => plural(count, "wrapper"),
  mechanism: (count) => `${count} via mechanism`,
  "serial-claim": (count) => plural(count, "serial claim"),
};

/**
 * The dependency verdict as a compact strip: who depends on this coin, how much
 * known USD rides on it, and what it depends on. An empty direction is one
 * muted sentence, not a display-size "None". A total prints only when it is
 * known (`directKnown`); otherwise "–" with the reason.
 */
export function DependencySummary({ symbol, context, usage, marketCapAsOf }: {
  symbol: string;
  context: DetailDependencyContext;
  usage: readonly PublishedCollateralUsageEntry[];
  marketCapAsOf: number | null;
}) {
  const { exposure, directKnown, upstreams } = context;
  const direct = exposure?.direct;
  const dependentCount = exposure?.dependentCount ?? 0;
  const excludedCount = direct?.excludedSupplyUnknownIds.length ?? 0;
  const exposureKnown = Boolean(direct && directKnown);
  const breakdown = (Object.keys(RELATIONSHIP_BREAKDOWN) as PublishedCollateralUsageEntry["relationshipType"][])
    .map((kind) => ({ kind, count: usage.filter((entry) => entry.relationshipType === kind).length }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count)
    .map(({ kind, count }) => RELATIONSHIP_BREAKDOWN[kind](count))
    .join(" · ");
  const upstreamSymbols = [...new Set(upstreams.map((entry) => entry.coin.symbol))];
  const asOf = isoDate(marketCapAsOf);

  const cells: SummaryCell[] = [];
  if (dependentCount > 0) {
    cells.push({
      key: "dependents",
      label: `Depend on ${symbol}`,
      value: String(dependentCount),
      sub: breakdown || plural(dependentCount, "direct dependent"),
    }, {
      key: "exposure",
      label: "Known direct exposure",
      value: exposureKnown ? formatCurrency(direct!.knownUsd) : null,
      sub: exposureKnown
        ? asOf === null ? "Market-cap date unavailable" : <>Market caps as of <span className="whitespace-nowrap">{asOf}</span></>
        : "Direct USD exposure unavailable",
    });
  }
  if (upstreamSymbols.length > 0) {
    cells.push({
      key: "upstreams",
      label: `${symbol} depends on`,
      value: String(upstreamSymbols.length),
      sub: new Intl.ListFormat("en", { type: "conjunction" }).format(
        upstreamSymbols.length > 3 ? [...upstreamSymbols.slice(0, 3), `${upstreamSymbols.length - 3} more`] : upstreamSymbols,
      ),
    });
  }

  const absence = dependentCount === 0 && upstreamSymbols.length === 0
    ? `No tracked stablecoin depends on ${symbol}, and its backing has no scored links to other stablecoins.`
    : dependentCount === 0 ? `No tracked stablecoin depends on ${symbol}.`
      : upstreamSymbols.length === 0 ? `${symbol}'s own backing has no scored links to other stablecoins.`
        : null;
  const caveats = [
    // When no dependent has a market cap the "unavailable" cell already says so.
    exposureKnown && excludedCount > 0 ? `${plural(excludedCount, "dependent")} without a market cap ${excludedCount === 1 ? "is" : "are"} left out of the exposure total.` : null,
    exposureKnown && direct!.unknownShareEdgeCount > 0 ? `${plural(direct!.unknownShareEdgeCount, "link")} ${direct!.unknownShareEdgeCount === 1 ? "has" : "have"} an unknown share, so the exposure total is incomplete.` : null,
    direct?.integrityFlag ? "A dependent's published backing shares add up to more than 100%, so the exposure total is incomplete." : null,
    absence,
  ].filter((line): line is string => line !== null);

  return (
    <section aria-label="Dependency summary" className="space-y-3 border-b border-border/40 pb-5">
      {cells.length > 0 ? (
        <dl className={`grid gap-x-6 gap-y-4 ${SUMMARY_COLUMNS_CLASS[cells.length]}`}>
          {cells.map((cell) => (
            <div key={cell.key} className="min-w-0 space-y-0.5">
              <dt className="pharos-label">{cell.label}</dt>
              <dd className={cell.value === null ? "font-mono text-lg text-muted-foreground" : "font-mono text-lg font-semibold tabular-nums text-foreground"}>
                {cell.value ?? "–"}
              </dd>
              <dd className="text-xs text-muted-foreground">{cell.sub}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {caveats.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {caveats.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

/** What this coin's backing rests on: published serial and basket links, by share. */
export function UpstreamList({ symbol, upstreams }: {
  symbol: string;
  upstreams: readonly PublishedCollateralUsageEntry[];
}) {
  const rows = [...upstreams].sort((a, b) =>
    (dependencyEntryShare(b) ?? -1) - (dependencyEntryShare(a) ?? -1) || a.coin.symbol.localeCompare(b.coin.symbol));
  return (
    <section aria-label={`${symbol} depends on`} className="space-y-2">
      <ListHeading title={`${symbol} depends on`} count={rows.length} caption={`Share of ${symbol}'s backing held in each.`} />
      <CappedList
        items={rows}
        noun="links"
        render={(entry) => {
          const detail = dependencyRoleDetail(entry);
          return (
            <DependencyRow
              key={`${entry.coin.id}:${entry.edgeType}`}
              id={entry.coin.id}
              name={entry.coin.name}
              symbol={entry.coin.symbol}
              detail={entry.edgeType === "serial" ? `${detail} · full claim` : detail}
              barFraction={dependencyEntryShare(entry)}
              grade={entry.grade}
              ariaLabel={dependencyRowAriaLabel(entry.coin.symbol, detail, [entry.grade ? `Safety grade ${entry.grade}` : null])}
            />
          );
        }}
      />
    </section>
  );
}

type Role = NonNullable<SafetyScoreV9CurrentCard["dependencies"]["roles"]>[number];

/** Each upstream role the Safety Score charges (serial claim, basket, exit, control, oracle). */
export function ScoredRoleList({ roles, gradeOf }: { roles: readonly Role[]; gradeOf: (id: string) => ReportCardGrade | null | undefined }) {
  return (
    <section aria-label="Scored dependency roles" className="space-y-2">
      <ListHeading
        title="Scored dependency roles"
        count={roles.length}
        caption="How the Safety Score charges each upstream. Figure: the role score out of 100."
      />
      <CappedList
        items={roles}
        noun="roles"
        render={(role) => {
          const meta = CLIENT_TRACKED_META_BY_ID.get(role.upstreamAssetId);
          const symbol = meta?.symbol ?? role.upstreamAssetId;
          const detail = `${DEPENDENCY_ROLE_LABELS[role.role]} · ${role.weight === null ? "weight unknown" : `${formatDependencyShare(role.weight)} weight`}`;
          const score = role.score === null ? null : `${Math.round(role.score)}/100`;
          return (
            <DependencyRow
              key={role.edgeKey}
              id={role.upstreamAssetId}
              name={meta?.name ?? symbol}
              symbol={symbol}
              detail={detail}
              value={score}
              grade={gradeOf(role.upstreamAssetId)}
              ariaLabel={dependencyRowAriaLabel(symbol, detail, [score === null ? "role score unavailable" : `role score ${score}`])}
            />
          );
        }}
      />
    </section>
  );
}

type CoverageRow = NonNullable<SafetyScoreV9CurrentCard["dependencyCoverage"]>[number];

function provenanceLine(identityVerified: boolean, sourceAsOf: string | null): string {
  return `${identityVerified ? "Identity verified" : "Identity unverified"} · ${sourceAsOf ? `source as of ${sourceAsOf}` : "source date unavailable"}`;
}

/** Holdings named in reserves but outside the scored graph, grouped once per plain-language reason. */
export function OutsideGraphList({ coverage }: { coverage: readonly CoverageRow[] }) {
  const groups = groupCoverageByReason(coverage);
  return (
    <section aria-label="Known but not scored" className="@container space-y-3">
      <ListHeading
        title="Known but not scored"
        count={coverage.length}
        caption="Named in reserves but left out of the graph and exposure totals."
      />
      {groups.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <p className="text-xs font-medium text-foreground">{group.label}</p>
          <ul className="grid gap-x-8 gap-y-1.5 @xl:grid-cols-2 @4xl:grid-cols-3">
            {group.rows.map((row, index) => (
              <li key={`${row.upstreamAssetId ?? row.upstreamLabel}:${row.reason}:${index}`} className="min-w-0 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {row.identityVerified && row.upstreamAssetId ? (
                    <Link href={buildStablecoinUrl(row.upstreamAssetId)} className="pharos-focus-ring min-w-0 rounded-sm font-medium hover:underline">{row.upstreamLabel}</Link>
                  ) : (
                    <span className="min-w-0 font-medium">{row.upstreamLabel}</span>
                  )}
                  <span className={row.share === null ? "text-xs text-muted-foreground" : "font-mono text-sm tabular-nums text-muted-foreground"}>
                    {row.share === null ? "Share unknown" : formatDependencyShare(row.share)}
                  </span>
                </div>
                {group.shared ? null : <p className="text-xs text-muted-foreground">{provenanceLine(row.identityVerified, row.sourceAsOf)}</p>}
              </li>
            ))}
          </ul>
          {group.shared ? <p className="text-xs text-muted-foreground">{provenanceLine(group.shared.identityVerified, group.shared.sourceAsOf)}</p> : null}
        </div>
      ))}
    </section>
  );
}
