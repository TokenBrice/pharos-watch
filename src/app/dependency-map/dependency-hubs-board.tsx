"use client";

import Link from "next/link";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { Card, CardContent } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatCurrency } from "@shared/lib/format";
import { trackEvent } from "@/lib/analytics";
import type { DependencyHubsModel } from "@/lib/dependency-hubs-model";

export function DependencyHubsBoard({ model, logos }: { model: DependencyHubsModel; logos?: Record<string, string> }) {
  const hubs = model.hubs.slice(0, 6);
  if (hubs.length === 0) return null;
  const maxExposure = model.hubs[0].direct.knownUsd;
  const asOf = model.marketCapAsOf === null ? "an unknown market-cap date" : new Date(model.marketCapAsOf * 1000).toISOString();
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
          <TableBody>{hubs.map(hub => (
            <TableRow key={hub.id}>
              <TableCell><div className="flex items-center gap-3"><StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={30} /><div><p className="font-semibold">{hub.label}</p><p className="text-xs text-muted-foreground">{hub.edgeTypeBreakdown.map(entry => `${entry.type} ${entry.edgeCount}`).join(" · ")}</p><p className="text-xs text-muted-foreground">{hub.hubMcapUsd === null ? "mcap n/a" : `Own market cap ${formatCurrency(hub.hubMcapUsd, 2)}`}</p></div></div></TableCell>
              <TableCell><p className="pharos-numeric font-semibold">{hub.direct.excludedSupplyUnknownIds.length === hub.dependentCount ? "n/a" : formatCurrency(hub.direct.knownUsd, 2)}</p><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted/45" aria-hidden="true"><div className="h-full rounded-full bg-frost-blue" style={{ width: `${maxExposure > 0 ? hub.direct.knownUsd / maxExposure * 100 : 0}%` }} /></div>{!hub.direct.complete && <p className="text-xs text-muted-foreground">{hub.direct.excludedSupplyUnknownIds.length} supplies unavailable; {hub.direct.unknownShareEdgeCount} shares unknown{hub.direct.integrityFlag ? "; basket shares require review" : ""}.</p>}</TableCell>
              <TableCell className="pharos-numeric">{formatCurrency(hub.ownFamilyUsd, 2)}</TableCell>
              <TableCell className="pharos-numeric">{formatCurrency(hub.vaultClaimUsd, 2)}</TableCell>
              <TableCell className="pharos-numeric">{hub.dependentCount}</TableCell>
              <TableCell>{hub.topDependent ? `${Math.round(hub.topDependent.shareOfHubExposure * 100)}% from ${hub.topDependentSymbol}` : "n/a"}</TableCell>
              <TableCell><Link href={buildStablecoinUrl(hub.id)} className="pharos-focus-ring rounded-sm text-xs text-frost-blue hover:text-foreground" aria-label={`Open coin ${hub.label}`} onClick={() => trackEvent("dependency_map_action", { action: "hub_open_coin", value: hub.id })}>Open coin</Link></TableCell>
            </TableRow>
          ))}</TableBody>
        </TableFrame>
      </CardContent>
    </Card>
  );
}
