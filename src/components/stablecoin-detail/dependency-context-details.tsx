"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { DEPENDENCY_RELATIONSHIP_LABELS, DEPENDENCY_ROLE_LABELS } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import type { DetailDependencyContext } from "./dependency-context-model";
import { ShowAllToggle } from "./disclosure-toggles";
import { DETAIL_MODULE_TITLE_CLASS } from "./section-title-class";

const PREVIEW_COUNT = 5;

function shareLabel(share: number | null): string {
  if (share === null) return "Share unknown";
  if (share > 0 && share < 0.0001) return "<0.01%";
  return `${Number((share * 100).toFixed(4))}%`;
}

function AssetLink({ id, label }: { id: string; label: string }) {
  return <Link href={buildStablecoinUrl(id)} className="pharos-focus-ring font-medium hover:underline">{label}</Link>;
}

/**
 * Rows grouped under one tag line per group (first-seen order) instead of the
 * same tag repeated on every row; the first five rows show, "Show all N" the rest.
 */
function GroupedRows<T>({ items, groupLabel, rowKey, renderRow, noun }: {
  items: readonly T[];
  groupLabel: (item: T) => string;
  rowKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  noun: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, PREVIEW_COUNT);
  const groups = new Map<string, T[]>();
  for (const item of visible) {
    const label = groupLabel(item);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  const totals = new Map<string, number>();
  for (const item of items) totals.set(groupLabel(item), (totals.get(groupLabel(item)) ?? 0) + 1);
  return (
    <>
      <div className="space-y-3">
        {[...groups].map(([label, rows]) => (
          <div key={label} className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              {label} <span className="font-mono tabular-nums">{totals.get(label)}</span>
            </p>
            <ul className="space-y-1.5 text-sm">
              {rows.map((row) => <li key={rowKey(row)} className="flex flex-wrap items-baseline gap-x-2">{renderRow(row)}</li>)}
            </ul>
          </div>
        ))}
      </div>
      {items.length > PREVIEW_COUNT ? (
        <ShowAllToggle open={showAll} onToggle={() => setShowAll((prev) => !prev)} total={items.length} noun={noun} />
      ) : null}
    </>
  );
}

export function DependencyContextDetails({ card, context, marketCapAsOf }: {
  card: SafetyScoreV9CurrentCard;
  context: DetailDependencyContext;
  marketCapAsOf: number | null;
}) {
  const { exposure, upstreams } = context;
  const direct = exposure?.direct;
  const dependentCount = exposure?.dependentCount ?? 0;
  const excludedCount = direct?.excludedSupplyUnknownIds.length ?? 0;
  const allSupplyUnknown = dependentCount > 0 && excludedCount === dependentCount;
  const roles = card.dependencies.roles;
  const coverage = card.dependencyCoverage;
  const hasDependents = dependentCount > 0;
  const hasUpstreams = upstreams.length > 0;
  const hasRoles = (roles?.length ?? 0) > 0;
  const hasCoverage = (coverage?.length ?? 0) > 0;
  const emptyQuadrants = [
    !hasDependents ? "dependents" : null,
    !hasUpstreams ? "upstream links" : null,
    !hasRoles ? "scored roles" : null,
    !hasCoverage ? "outside-graph relationships" : null,
  ].filter((label): label is string => label !== null);
  const emptySummary = new Intl.ListFormat("en", { type: "disjunction" }).format(emptyQuadrants);

  return (
    <div className={emptyQuadrants.length < 3 ? "grid gap-5 border-b border-border/40 pb-6 sm:grid-cols-2" : "space-y-3 border-b border-border/40 pb-6"}>
      {hasDependents ? <section aria-label="What depends on me" className="space-y-2">
        <h3 className={DETAIL_MODULE_TITLE_CLASS}>What depends on me</h3>
        <p className="text-sm">
          <span className="font-mono tabular-nums">{dependentCount}</span> direct {dependentCount === 1 ? "dependent" : "dependents"}.
          {" "}{allSupplyUnknown ? "Direct USD exposure unavailable." : <><span className="font-mono tabular-nums">{formatCurrency(direct?.knownUsd ?? 0)}</span> known direct exposure.</>}
        </p>
        <p className="text-xs text-muted-foreground">
          Published links weighted by dependent market cap{marketCapAsOf === null ? "; market-cap date unavailable" : ` as of ${new Date(marketCapAsOf * 1000).toISOString().slice(0, 10)}`}.
        </p>
        {excludedCount > 0 ? <p className="text-xs text-muted-foreground">{excludedCount} {excludedCount === 1 ? "dependent has" : "dependents have"} unavailable market cap and {excludedCount === 1 ? "is" : "are"} excluded from USD exposure.</p> : null}
        {direct && direct.unknownShareEdgeCount > 0 ? <p className="text-xs text-muted-foreground">{direct.unknownShareEdgeCount} published {direct.unknownShareEdgeCount === 1 ? "link has" : "links have"} an unknown share; USD exposure is incomplete.</p> : null}
        {direct?.integrityFlag ? <p className="text-xs text-muted-foreground">Published backing shares have an integrity warning; USD exposure is incomplete.</p> : null}
      </section> : null}
      {hasUpstreams ? <section aria-label="What I depend on" className="space-y-2">
        <h3 className={DETAIL_MODULE_TITLE_CLASS}>What I depend on</h3>
        <GroupedRows
          items={upstreams}
          groupLabel={(entry) => `${DEPENDENCY_RELATIONSHIP_LABELS[entry.relationshipType]} (${entry.edgeType})`}
          rowKey={(entry) => `${entry.coin.id}:${entry.edgeType}`}
          renderRow={(entry) => <>
            <AssetLink id={entry.coin.id} label={entry.coin.symbol} />
            <span className="font-mono text-xs tabular-nums">{entry.edgeType === "serial" ? "Full claim (100%)" : shareLabel(entry.weight)}</span>
          </>}
          noun="upstream links"
        />
      </section> : null}
      {hasRoles ? <section aria-label="Scored role dependencies (not drawn)" className="space-y-2">
        <h3 className={DETAIL_MODULE_TITLE_CLASS}>Scored role dependencies (not drawn)</h3>
        <GroupedRows
          items={roles ?? []}
          groupLabel={(role) => DEPENDENCY_ROLE_LABELS[role.role]}
          rowKey={(role) => role.edgeKey}
          renderRow={(role) => <>
            <AssetLink id={role.upstreamAssetId} label={CLIENT_TRACKED_META_BY_ID.get(role.upstreamAssetId)?.symbol ?? role.upstreamAssetId} />
            <span className="font-mono text-xs tabular-nums">{shareLabel(role.weight)}</span>
            <span className="text-xs text-muted-foreground">{role.score === null ? "Role score unavailable" : `Role score ${Math.round(role.score)}/100`}</span>
          </>}
          noun="scored roles"
        />
      </section> : null}
      {hasCoverage ? <section aria-label="Known, not in the scored graph" className="space-y-2">
        <h3 className={DETAIL_MODULE_TITLE_CLASS}>Known, not in the scored graph</h3>
            <p className="text-xs text-muted-foreground">Excluded from the graph and exposure totals.</p>
            <ul className="space-y-3 text-sm">
              {coverage?.map((row, index) => <li key={`${row.upstreamAssetId ?? row.upstreamLabel}:${row.reason}:${index}`} className="space-y-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {row.identityVerified && row.upstreamAssetId ? <AssetLink id={row.upstreamAssetId} label={row.upstreamLabel} /> : <span className="font-medium">{row.upstreamLabel}</span>}
                  <span className="font-mono text-xs tabular-nums">{shareLabel(row.share)}</span>
                </div>
                <p className="break-words text-xs text-muted-foreground">Reason: {row.reason}. {row.identityVerified ? "Identity verified." : "Identity unverified."} {row.sourceAsOf ? `Source as of ${row.sourceAsOf}.` : "Source date unavailable."}</p>
              </li>)}
            </ul>
      </section> : null}
      {emptyQuadrants.length > 0 ? <p className="text-xs text-muted-foreground sm:col-span-2">No {emptySummary} published.</p> : null}
    </div>
  );
}
