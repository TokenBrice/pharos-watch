"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { LighthouseLedgerModel } from "./story-model";

export function HarborLedger({ ledger }: { ledger: LighthouseLedgerModel }) {
  if (!ledger.selectedShip) {
    return (
      <div className="lh-empty-story-state">
        <p className="text-sm font-medium text-foreground">No harbor is selected.</p>
        <p className="text-sm text-muted-foreground">
          The ledger fills once chain data produces at least one visible harbor.
        </p>
      </div>
    );
  }

  return (
    <div className="lh-harbor-ledger" data-testid="lighthouse-harbor-ledger">
      <div className="lh-harbor-ledger__title">
        <div>
          <p className="pharos-kicker">Selected Harbor</p>
          <p className="text-lg font-semibold text-foreground">{ledger.selectedShip.name}</p>
          <p className="text-sm text-muted-foreground">{ledger.caveat}</p>
        </div>
        {ledger.selectedChainHref ? (
          <Link
            href={ledger.selectedChainHref}
            className="pharos-focus-ring inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground hover:border-frost-blue/50"
          >
            Open harbor
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </div>

      <div className="lh-ledger-grid">
        {ledger.facts.map((fact) => (
          <div key={fact.label} className="lh-ledger-row">
            <span>{fact.label}</span>
            <strong>{fact.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
