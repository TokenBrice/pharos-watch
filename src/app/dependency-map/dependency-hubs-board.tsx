"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { Card, CardContent } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { CoinStateChip } from "@/components/coin-state-chip";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatCurrency } from "@shared/lib/format";
import { formatEventTimestamp } from "@/lib/depeg-event-display";
import { trackEvent } from "@/lib/analytics";
import type { DependencyHub, DependencyHubsModel } from "@shared/lib/dependency-hubs-model";
import type { CoinState } from "@shared/lib/coin-state";
import { formatClaimSubtotal } from "@/lib/dependency-watershed/known";

type CoinStates = ReadonlyMap<string, readonly CoinState[]>;

const INITIAL_LIVE_INCIDENTS = 3;

function formatDirectExposure(hub: DependencyHub): string {
  return hub.directKnown ? `${formatCurrency(hub.direct.knownUsd, 2)}${hub.direct.complete ? "" : " (known only)"}` : "Unavailable";
}

/**
 * The live-state layer over the structural map: published upstreams in a live
 * exceptional state now (`useCoinStates`), in hub-model order, with the direct
 * exposure their dependents map to them. Pre-launch and deadline states are
 * scheduled, not incidents, so they never list an upstream. Edges, totals and
 * rankings are unchanged, and an upstream without a known state is not listed.
 */
export function LiveIncidentsUpstream({ model, coinStates, logos, onExposure }: { model: DependencyHubsModel; coinStates: CoinStates; logos?: Record<string, string>; onExposure?: (id: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const incidents = model.hubs.flatMap(hub => {
    const state = coinStates.get(hub.id)?.find(s => s.kind !== "pre-launch" && s.kind !== "deadline");
    return state ? [{ hub, state }] : [];
  });
  if (incidents.length === 0) return null;
  const visibleIncidents = showAll ? incidents : incidents.slice(0, INITIAL_LIVE_INCIDENTS);
  const hasMore = incidents.length > INITIAL_LIVE_INCIDENTS;

  return (
    <section className="pharos-card-shell space-y-2.5 p-3.5 sm:p-4" aria-labelledby="live-incidents-upstream-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h2 id="live-incidents-upstream-heading" className="text-sm font-semibold text-foreground">Live incidents upstream</h2>
          <p className="text-xs text-muted-foreground">
            {incidents.length} published {incidents.length === 1 ? "upstream is" : "upstreams are"} in an exceptional state now, ranked by direct mapped dependent exposure. Linked coins; not a loss forecast.
          </p>
        </div>
        {hasMore ? (
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll((prev) => !prev)}
            className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 shrink-0 items-center gap-1 px-3 py-1.5 text-xs font-medium text-foreground sm:min-h-8"
          >
            {showAll ? (
              <>
                Show top {INITIAL_LIVE_INCIDENTS}
                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              </>
            ) : (
              <>
                Show all {incidents.length}
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              </>
            )}
          </button>
        ) : null}
      </div>
      <ul className="divide-y divide-border/60">{visibleIncidents.map(({ hub, state }) => (
        <li key={hub.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 text-sm">
          <StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={20} />
          <Link href={buildStablecoinUrl(hub.id)} className="pharos-focus-ring rounded-sm font-semibold hover:underline">{hub.label}</Link>
          <CoinStateChip state={state} showDetail />
          <span className="text-xs text-muted-foreground">{hub.dependentCount} direct {hub.dependentCount === 1 ? "dependent" : "dependents"}{hub.topDependent ? ` · ${Math.round(hub.topDependent.shareOfHubExposure * 100)}% from ${hub.topDependentSymbol}` : ""}</span>
          <span className="pharos-numeric ml-auto font-semibold">{formatDirectExposure(hub)}</span>
          {onExposure && (
            <button
              type="button"
              aria-label={`Trace exposure from ${hub.label}`}
              className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center px-3 py-1 text-xs font-medium text-foreground sm:min-h-8"
              onClick={() => onExposure(hub.id)}
            >
              Trace exposure →
            </button>
          )}
        </li>
      ))}</ul>
    </section>
  );
}

export function DependencyHubsBoard({ model, logos, onExposure, coinStates }: { model: DependencyHubsModel; logos?: Record<string, string>; onExposure?: (id: string) => void; coinStates?: CoinStates }) {
  const hubs = model.hubs.slice(0, 6);
  if (hubs.length === 0) return null;
  const maxExposure = model.hubs[0].direct.knownUsd;
  const asOf = model.marketCapAsOf === null ? "an unknown market-cap date" : formatEventTimestamp(model.marketCapAsOf, true);
  return (
    <Card className="hidden overflow-hidden rounded-xl border-border/70 shadow-none md:block">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Largest mapped direct exposures</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">Ranked by known dependent supply × mapped share, as of {asOf}, across the full published graph of tracked stablecoins.</p>
          <p className="text-xs text-muted-foreground">Wrapper claims pass through to a parent. Vault claims settle in a parent. Collateral shares measure mapped backing.</p>
        </div>
        <TableFrame tableId="dependency-hubs-board" testId="dependency-hubs-board-table" density="compact" chrome="embedded" className="rounded-md border-border/70 bg-background/35" tableClassName="min-w-[64rem] text-left" viewportProps={{ mobileScrollHint: false }}>
          <TableCaption>Top {hubs.length} of {model.upstreamHubCount}</TableCaption>
          <TableHeader><TableRow>
            <TableHead scope="col">Upstream</TableHead>
            <TableHead scope="col">Direct exposure</TableHead>
            <TableHead scope="col">Of which own-family wrappers</TableHead>
            <TableHead scope="col">Of which vault claims</TableHead>
            <TableHead scope="col">Direct dependents</TableHead>
            <TableHead scope="col">Top dependent share</TableHead>
            <TableHead scope="col">Action</TableHead>
          </TableRow></TableHeader>
          <TableBody>{hubs.map(hub => {
            const directKnown = hub.directKnown;
            return (
            <TableRow key={hub.id}>
              <TableCell><div className="flex items-center gap-3"><StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={30} /><div><p className="flex flex-wrap items-center gap-2 font-semibold">{hub.label}{coinStates?.get(hub.id)?.slice(0, 1).map(state => <CoinStateChip key={state.kind} state={state} />)}</p><p className="text-xs text-muted-foreground">{hub.edgeTypeBreakdown.map(entry => `${entry.type} ${entry.edgeCount}`).join(" · ")}</p><p className="text-xs text-muted-foreground">{hub.hubMcapUsd === null ? "mcap n/a" : `Own market cap ${formatCurrency(hub.hubMcapUsd, 2)}`}</p></div></div></TableCell>
              <TableCell><p className="pharos-numeric font-semibold">{formatDirectExposure(hub)}</p><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted/45" aria-hidden="true">{directKnown && <div className="h-full rounded-full bg-frost-blue" style={{ width: `${maxExposure > 0 ? hub.direct.knownUsd / maxExposure * 100 : 0}%` }} />}</div>{!hub.direct.complete && <p className="text-xs text-muted-foreground">{hub.direct.excludedSupplyUnknownIds.length} supplies unavailable; {hub.direct.unknownShareEdgeCount} shares unknown{hub.direct.integrityFlag ? "; basket shares require review" : ""}.</p>}</TableCell>
              <TableCell className="pharos-numeric max-w-72 whitespace-normal">{hub.unknownFormCount > 0 && hub.passThroughCount + hub.vaultClaimCount === 0 ? "Split unavailable" : <>{formatClaimSubtotal(hub.ownFamilyUsd, hub.claimAvailability.classified)}{hub.unknownFormCount > 0 && <p className="text-xs text-muted-foreground">Classified claims only</p>}</>}{hub.unknownFormCount > 0 && <p className="text-xs text-muted-foreground">Wrapper/vault split unavailable{hub.unknownFormUsd === null ? "; supply unavailable" : ` for ${formatCurrency(hub.unknownFormUsd, 2)} of known serial exposure`}.</p>}</TableCell>
              <TableCell className="pharos-numeric max-w-56 whitespace-normal">{hub.unknownFormCount > 0 && hub.vaultClaimCount === 0 ? "Split unavailable" : <>{formatClaimSubtotal(hub.vaultClaimUsd, hub.claimAvailability["vault-claim"])}{hub.unknownFormCount > 0 && <p className="text-xs text-muted-foreground">Classified claims only</p>}</>}</TableCell>
              <TableCell className="pharos-numeric">{hub.dependentCount}</TableCell>
              <TableCell>{hub.topDependent ? `${Math.round(hub.topDependent.shareOfHubExposure * 100)}% from ${hub.topDependentSymbol}` : "n/a"}</TableCell>
              <TableCell><div className="flex items-center gap-2"><Link href={buildStablecoinUrl(hub.id)} className="pharos-focus-ring inline-flex min-h-11 items-center rounded-sm text-xs text-brand-accent-text hover:text-foreground" aria-label={`Open coin ${hub.label}`} onClick={() => trackEvent("dependency_map_action", { action: "hub_open_coin", value: hub.id })}>Open profile →</Link>{onExposure && <button type="button" aria-label={`Trace exposure from ${hub.label}`} className="pharos-focus-ring pharos-control-pill inline-flex min-h-8 items-center px-2.5 py-1 text-xs font-medium text-foreground" onClick={() => onExposure(hub.id)}>Trace exposure →</button>}</div></TableCell>
            </TableRow>
          ); })}</TableBody>
        </TableFrame>
      </CardContent>
    </Card>
  );
}
