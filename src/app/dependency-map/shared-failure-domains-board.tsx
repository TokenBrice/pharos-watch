"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { FAILURE_DOMAIN_KIND_LABELS } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { SupplyOf } from "@shared/lib/dependency-exposure";
import { buildSharedFailureDomainsModel, type SharedFailureDomainCard, type SharedFailureDomainGroups, type SharedFailureDomainRow } from "@/lib/shared-failure-domains-model";

export interface SharedFailureDomainsBoardProps {
  groups: SharedFailureDomainGroups | null;
  cards: readonly SharedFailureDomainCard[];
  supplyOf: SupplyOf;
}

function DomainRows({ rows }: { rows: readonly SharedFailureDomainRow[] }) {
  return <TableBody>{rows.map(row => (
    <TableRow key={row.id}>
      <TableCell><p className="font-semibold">{FAILURE_DOMAIN_KIND_LABELS[row.kind]}</p><p className="max-w-64 break-words text-xs text-muted-foreground">{row.key}</p></TableCell>
      <TableCell>
        <p className="pharos-numeric font-semibold">{row.knownUsd === null ? "Unavailable" : formatCurrency(row.knownUsd, 2)}</p>
        <p className="text-xs text-muted-foreground">{row.publicationMemberCount > 0 && `${row.publicationMemberCount} publication-bound supplies`}{row.publicationMemberCount > 0 && row.marketCapMemberCount > 0 && "; "}{row.marketCapMemberCount > 0 && `${row.marketCapMemberCount} market caps`}</p>
        {row.unavailableMemberCount > 0 && <p className="text-xs text-muted-foreground">{row.unavailableMemberCount} member supplies unavailable{row.knownUsd !== null ? "; known subtotal only" : ""}.</p>}
        {row.oldestAsOfSec !== null && <p className="text-xs text-muted-foreground">Oldest supply date: {new Date(row.oldestAsOfSec * 1000).toISOString().slice(0, 10)}</p>}
        {row.supplyDateIncomplete && <p className="text-xs text-muted-foreground">Some supply dates unavailable.</p>}
      </TableCell>
      <TableCell><ul className="flex max-w-80 flex-wrap gap-x-3 gap-y-1">{row.members.map(member => <li key={member.id}><Link href={buildStablecoinUrl(member.id)} title={member.name} className="pharos-focus-ring inline-flex min-h-11 items-center rounded-sm text-xs text-frost-blue hover:text-foreground">{member.symbol}</Link></li>)}</ul></TableCell>
      <TableCell className="max-w-96">
        {row.effects.length === 0 ? <p className="text-xs text-muted-foreground">No published effect references. This does not establish an absence of risk.</p> : <ul className="space-y-2 text-xs">{row.effects.map(effect => <li key={effect.assetId}>
          <p className="font-semibold">{effect.label}</p>
          {effect.caps.map((cap, index) => <p key={`cap-${index}`}>{cap.kind} cap: {cap.limit}</p>)}
          {effect.adjustments.map((adjustment, index) => <p key={`adjustment-${index}`}>Deployment adjustment: {adjustment.scoreBefore} → {adjustment.scoreAfter} ({adjustment.adjustmentPoints} points)</p>)}
          {effect.referencesUnresolved && <p className="text-muted-foreground">Some referenced cap or deployment adjustment values are unavailable.</p>}
        </li>)}</ul>}
        {row.pricedEffectsIncomplete && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">Priced effects incomplete: an evaluated structural signal has no matching published cap or deployment adjustment reference. Published scores are unchanged.</p>}
      </TableCell>
    </TableRow>
  ))}</TableBody>;
}

function DomainTable({ rows, total, tableId }: { rows: readonly SharedFailureDomainRow[]; total: number; tableId: string }) {
  return <TableFrame tableId={tableId} density="compact" chrome="embedded" className="rounded-md border-border/70 bg-background/35" tableClassName="min-w-[52rem] text-left">
    <TableCaption>{rows.length === total ? `All ${total} shared failure domains` : `${rows.length} of ${total} shared failure domains`}</TableCaption>
    <TableHeader><TableRow><TableHead scope="col">Kind / identity</TableHead><TableHead scope="col">Member supply</TableHead><TableHead scope="col">Member coins</TableHead><TableHead scope="col">Published priced effects</TableHead></TableRow></TableHeader>
    <DomainRows rows={rows} />
  </TableFrame>;
}

export function SharedFailureDomainsBoard({ groups, cards, supplyOf }: SharedFailureDomainsBoardProps) {
  const model = useMemo(() => buildSharedFailureDomainsModel({ groups, cards, supplyOf }), [groups, cards, supplyOf]);
  const visible = model.rows.slice(0, 10);
  const remaining = model.rows.slice(10);
  return <Card className="overflow-hidden rounded-xl border-border/70 shadow-none">
    <CardContent className="space-y-4 p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Shared failure domains</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">Shared control or custody identity across tracked coins; not an additive loss estimate</p>
        <p className="max-w-3xl text-xs text-muted-foreground">Ranked by known member supply, using publication-bound supply where available and otherwise labelled market cap. Coins can belong to several groups; do not add group totals.</p>
      </div>
      {model.status === "not-published" ? <p className="text-sm text-muted-foreground">Shared failure domains were not published for this generation.</p> : model.rows.length === 0 ? <p className="text-sm text-muted-foreground">The published census contains no groups with at least two member coins.</p> : <>
        <DomainTable rows={visible} total={model.rows.length} tableId="shared-failure-domains" />
        {remaining.length > 0 && <details><summary className="pharos-focus-ring cursor-pointer rounded-sm py-3 text-sm">Show the remaining {remaining.length} of {model.rows.length} groups</summary><DomainTable rows={remaining} total={model.rows.length} tableId="shared-failure-domains-remaining" /></details>}
      </>}
    </CardContent>
  </Card>;
}
