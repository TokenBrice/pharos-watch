"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatCurrency } from "@shared/lib/format";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { DependencyGraphResponse } from "@shared/types/dependency-graph";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { downstreamHeadline } from "@/components/dependency-watershed/dependency-watershed";
import { computeDependencyExposure } from "@/hooks/use-dependency-exposure-mode";
import { trackEvent } from "@/lib/analytics";
import { formatEventTimestamp } from "@/lib/depeg-event-display";
import { formatHubDirect, hubDirectKnown } from "@/lib/dependency-watershed/known";
import type { DependencyHub, DependencyHubsModel } from "@shared/lib/dependency-hubs-model";

const INITIAL_HUBS = 8;
const HOP_ROWS = 10;

function HubSplit({ hub }: { hub: DependencyHub }) {
  return (
    <dl className="space-y-1 text-xs text-muted-foreground">
      <div><dt className="inline">Of which own-family wrappers: </dt><dd className="inline">{hub.unknownFormCount > 0 && hub.passThroughCount + hub.vaultClaimCount === 0 ? "Split unavailable" : <>{formatCurrency(hub.ownFamilyUsd, 2)}{hub.unknownFormCount > 0 ? " (classified claims only)" : ""}</>}</dd></div>
      <div><dt className="inline">Of which vault claims: </dt><dd className="inline">{hub.unknownFormCount > 0 && hub.vaultClaimCount === 0 ? "Split unavailable" : <>{formatCurrency(hub.vaultClaimUsd, 2)}{hub.unknownFormCount > 0 ? " (classified claims only)" : ""}</>}</dd></div>
      {hub.unknownFormCount > 0 && <div>Wrapper/vault split unavailable{hub.unknownFormUsd === null ? "; supply unavailable" : ` for ${formatCurrency(hub.unknownFormUsd, 2)} of known serial exposure`}.</div>}
      <div>{hub.topDependent ? `${Math.round(hub.topDependent.shareOfHubExposure * 100)}% from ${hub.topDependentSymbol}` : "Top dependent share unavailable"} · {hub.edgeTypeBreakdown.map(entry => `${entry.type} ${entry.edgeCount}`).join(" · ")} · {hub.hubMcapUsd === null ? "mcap n/a" : `own market cap ${formatCurrency(hub.hubMcapUsd, 2)}`}</div>
      {!hub.direct.complete && <div>{hub.direct.excludedSupplyUnknownIds.length} supplies unavailable; {hub.direct.unknownShareEdgeCount} shares unknown{hub.direct.integrityFlag ? "; basket shares require review" : ""}.</div>}
    </dl>
  );
}

function BasinDrillDown({ hub, publication, labelOf, hubIds, onExposure }: {
  hub: DependencyHub;
  publication: DependencyGraphResponse;
  labelOf: (id: string) => string;
  hubIds: ReadonlySet<string>;
  onExposure?: (id: string) => void;
}) {
  const [trail, setTrail] = useState<string[]>([hub.id]);
  const [allHops, setAllHops] = useState<ReadonlySet<number>>(new Set());
  const rootId = trail[trail.length - 1]!;
  const result = useMemo(() => computeDependencyExposure(publication, [rootId]), [publication, rootId]);
  const headline = downstreamHeadline(labelOf(rootId), result);
  const hops = [...new Set(result.rows.map(row => row.minHop))].sort((a, b) => a - b);
  return (
    <div className="space-y-3 pb-3 pl-1">
      {trail.length > 1 && (
        <nav aria-label="Basin trail" className="flex flex-wrap items-center gap-1 text-xs">
          {trail.map((id, index) => index < trail.length - 1
            ? <span key={id} className="flex items-center gap-1"><button type="button" className="pharos-focus-ring min-h-11 rounded-md px-1 underline" onClick={() => setTrail(trail.slice(0, index + 1))}>{labelOf(id)}</button><span aria-hidden="true">›</span></span>
            : <span key={id} aria-current="location" className="font-semibold">{labelOf(id)}</span>)}
        </nav>
      )}
      {trail.length === 1 && <HubSplit hub={hub} />}
      <div className="space-y-1">
        <p className="text-sm font-semibold">{headline.lead}</p>
        <p className="pharos-numeric text-xs text-muted-foreground">{headline.detail}</p>
        <p className="text-xs">Linked coins; not a loss forecast · publication supply basis</p>
      </div>
      {hops.map(hop => {
        const rows = result.rows.filter(row => row.minHop === hop).sort((a, b) => (b.exposureUsd ?? -1) - (a.exposureUsd ?? -1) || a.id.localeCompare(b.id));
        const shown = allHops.has(hop) ? rows : rows.slice(0, HOP_ROWS);
        return (
        <div key={hop} className="space-y-1">
          <p className="pharos-label">Hop {hop} · {shown.length < rows.length ? `top ${shown.length} of ${rows.length}` : `${rows.length} ${rows.length === 1 ? "coin" : "coins"}`}</p>
          <ul className="divide-y divide-border/40">
            {shown.map(row => (
              <li key={row.id} className="flex min-h-11 items-center justify-between gap-2 py-1 text-sm">
                <span className="min-w-0 truncate">{labelOf(row.id)}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="pharos-numeric text-xs text-muted-foreground">{row.share === null ? "share unknown" : `${(row.share * 100).toFixed(1)}%`}</span>
                  <span className="pharos-numeric text-xs">{row.exposureUsd === null ? "n/a" : formatCurrency(row.exposureUsd, 2)}</span>
                  {hubIds.has(row.id) && <button type="button" className="pharos-focus-ring min-h-11 rounded-md px-2 text-xs underline" aria-label={`Show what depends on ${labelOf(row.id)}`} onClick={() => setTrail([...trail, row.id])}>Own dependents ›</button>}
                </span>
              </li>
            ))}
          </ul>
          {rows.length > HOP_ROWS && <button type="button" className="pharos-focus-ring min-h-11 rounded-md px-1 text-xs underline" onClick={() => { const next = new Set(allHops); if (next.has(hop)) next.delete(hop); else next.add(hop); setAllHops(next); }}>{allHops.has(hop) ? `Show top ${HOP_ROWS}` : `Show all ${rows.length} at hop ${hop}`}</button>}
        </div>
        );
      })}
      <div className="flex flex-wrap gap-3">
        {onExposure && <button type="button" className="pharos-focus-ring min-h-11 rounded-md border border-border px-3 text-sm" aria-label={`Use ${labelOf(rootId)} as exposure root`} onClick={() => onExposure(rootId)}>Use as exposure root</button>}
        <Link href={buildStablecoinUrl(rootId)} aria-label={`Open coin ${labelOf(rootId)}`} className="pharos-focus-ring inline-flex min-h-11 items-center rounded-md px-2 text-sm text-frost-blue" onClick={() => trackEvent("dependency_map_action", { action: "hub_open_coin", value: rootId })}>Open coin</Link>
      </div>
    </div>
  );
}

/** Mobile per-hub drill-down: every upstream hub, ranked, with its downstream footprint by hop. */
export function DependencyMapBasinList({ model, publication, logos, labelOf, onExposure }: {
  model: DependencyHubsModel;
  publication: DependencyGraphResponse;
  logos?: Record<string, string>;
  labelOf: (id: string) => string;
  onExposure?: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const hubIds = useMemo(() => new Set(model.hubs.map(hub => hub.id)), [model]);
  if (model.hubs.length === 0) return null;
  const hubs = showAll ? model.hubs : model.hubs.slice(0, INITIAL_HUBS);
  const known = (hub: DependencyHub) => hubDirectKnown(hub, publication.edges);
  const max = Math.max(0, ...model.hubs.filter(known).map(hub => hub.direct.knownUsd));
  return (
    <section className="pharos-card-shell space-y-3 px-4 py-4 md:hidden" aria-labelledby="dependency-basin-list-title">
      <div className="space-y-1">
        <h2 id="dependency-basin-list-title" className="pharos-section-title">Upstream hubs</h2>
        <p className="text-xs text-muted-foreground">Direct mapped dependent supply, market-cap proxy basis as of {model.marketCapAsOf === null ? "an unknown date" : formatEventTimestamp(model.marketCapAsOf, true)}. Top {hubs.length} of {model.upstreamHubCount}.</p>
      </div>
      <ul className="divide-y divide-border/40">
        {hubs.map(hub => {
          const open = openId === hub.id;
          return (
            <li key={hub.id}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`basin-${hub.id}`}
                className="pharos-focus-ring flex min-h-11 w-full items-center gap-3 rounded-md py-2 text-left"
                onClick={() => setOpenId(open ? null : hub.id)}
              >
                <span aria-hidden="true" className="shrink-0"><StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={24} /></span>
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{labelOf(hub.id)}</span>
                    <span className="pharos-numeric shrink-0 text-xs">{formatHubDirect(hub, publication.edges, "n/a")} · {hub.dependentCount} {hub.dependentCount === 1 ? "dependent" : "dependents"}</span>
                  </span>
                  <span className="block h-1.5 w-full rounded-full bg-muted" aria-hidden="true">
                    {known(hub) && max > 0 && <span className="block h-1.5 rounded-full bg-foreground/60" style={{ width: `${(hub.direct.knownUsd / max) * 100}%` }} />}
                  </span>
                </span>
                <span aria-hidden="true" className="text-muted-foreground">{open ? "▾" : "▸"}</span>
              </button>
              {open && <div id={`basin-${hub.id}`}><BasinDrillDown hub={hub} publication={publication} labelOf={labelOf} hubIds={hubIds} onExposure={onExposure} /></div>}
            </li>
          );
        })}
      </ul>
      {model.hubs.length > INITIAL_HUBS && (
        <button type="button" className="pharos-focus-ring min-h-11 rounded-md px-2 text-sm underline" onClick={() => setShowAll(!showAll)}>
          {showAll ? `Show top ${INITIAL_HUBS}` : `Show all ${model.hubs.length} hubs`}
        </button>
      )}
    </section>
  );
}
