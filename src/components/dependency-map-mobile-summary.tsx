"use client";

import Link from "next/link";
import { formatCurrency } from "@shared/lib/format";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { trackEvent } from "@/lib/analytics";
import type { DependencyHubsModel } from "@/lib/dependency-hubs-model";

export function DependencyMapMobileSummary({ model, logos, onExposure }: { model: DependencyHubsModel; logos?: Record<string, string>; onExposure?: (id: string) => void }) {
  const hubs = model.hubs.slice(0, 6);
  if (hubs.length === 0) return null;
  const asOf = model.marketCapAsOf === null ? "an unknown market-cap date" : new Date(model.marketCapAsOf * 1000).toISOString();
  return (
    <Card className="rounded-xl border-border/70 shadow-none md:hidden">
      <CardHeader className="space-y-2">
        <CardTitle as="h2" className="text-lg">Largest mapped direct exposures</CardTitle>
        <p className="text-xs text-muted-foreground">Top {hubs.length} of {model.upstreamHubCount}</p>
        <p className="text-sm text-muted-foreground">Ranked by known dependent supply × mapped share, as of {asOf}, across the full published graph of tracked stablecoins.</p>
      </CardHeader>
      <CardContent className="divide-y divide-border/40 pt-0">
        {hubs.map(hub => (
          <div key={hub.id} className="flex items-start gap-3 px-1 py-3 first:pt-0">
            <StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={28} />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-sm font-semibold">{hub.label}</p>
              <p className="pharos-numeric text-sm">Direct exposure {hub.direct.excludedSupplyUnknownIds.length === hub.dependentCount ? "n/a" : formatCurrency(hub.direct.knownUsd, 2)}</p>
              <dl className="space-y-1 text-xs text-muted-foreground">
                <div><dt className="inline">Of which own-family wrappers: </dt><dd className="inline">{hub.unknownFormCount > 0 && hub.passThroughCount + hub.vaultClaimCount === 0 ? "Split unavailable" : <>{formatCurrency(hub.ownFamilyUsd, 2)}{hub.unknownFormCount > 0 ? " (classified claims only)" : ""}</>}</dd></div>
                <div><dt className="inline">Of which vault claims: </dt><dd className="inline">{hub.unknownFormCount > 0 && hub.vaultClaimCount === 0 ? "Split unavailable" : <>{formatCurrency(hub.vaultClaimUsd, 2)}{hub.unknownFormCount > 0 ? " (classified claims only)" : ""}</>}</dd></div>
                <div><dt className="inline">Direct dependents: </dt><dd className="inline">{hub.dependentCount}</dd></div>
              </dl>
              {hub.unknownFormCount > 0 && <p className="text-xs text-muted-foreground">Wrapper/vault split unavailable{hub.unknownFormUsd === null ? "; supply unavailable" : ` for ${formatCurrency(hub.unknownFormUsd, 2)} of known serial exposure`}.</p>}
              <p className="text-xs text-muted-foreground">{hub.topDependent ? `${Math.round(hub.topDependent.shareOfHubExposure * 100)}% from ${hub.topDependentSymbol}` : "Top dependent share unavailable"}</p>
              <p className="text-xs text-muted-foreground">{hub.edgeTypeBreakdown.map(entry => `${entry.type} ${entry.edgeCount}`).join(" · ")}. {hub.hubMcapUsd === null ? "mcap n/a" : `Own market cap ${formatCurrency(hub.hubMcapUsd, 2)}`}</p>
              {!hub.direct.complete && <p className="text-xs text-muted-foreground">{hub.direct.excludedSupplyUnknownIds.length} supplies unavailable; {hub.direct.unknownShareEdgeCount} shares unknown{hub.direct.integrityFlag ? "; basket shares require review" : ""}.</p>}
              <div className="flex gap-3"><Link href={buildStablecoinUrl(hub.id)} className="pharos-focus-ring inline-flex min-h-11 items-center rounded-sm text-xs text-frost-blue" aria-label={`Open coin ${hub.label}`} onClick={() => trackEvent("dependency_map_action", { action: "hub_open_coin", value: hub.id })}>Open coin</Link>{onExposure && <button type="button" aria-label={`Trace exposure from ${hub.label}`} className="pharos-focus-ring min-h-11 rounded px-2 text-sm underline" onClick={() => onExposure(hub.id)}>Exposure</button>}</div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
