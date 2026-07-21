"use client";

import { StablecoinLogo } from "@/components/stablecoin-logo";
import { STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE } from "@/components/stablecoin-detail/constants";
import { Skeleton } from "@/components/ui/skeleton";
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import type { StablecoinStaticMeta } from "@/lib/stablecoin-static-meta";

interface StablecoinDetailLoadingShellProps {
  coin: StablecoinStaticMeta;
  logoSrc?: string;
  description: string;
  statusLabel: string;
}

export function StablecoinDetailLoadingShell({
  coin,
  logoSrc,
  description,
  statusLabel,
}: StablecoinDetailLoadingShellProps) {
  return (
    <>
      <section className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex items-start gap-3">
              <StablecoinLogo src={logoSrc} name={coin.name} size={STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE} />
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-2xl font-extrabold tracking-tighter text-foreground">{coin.name}</h2>
                  <span className="text-base font-mono tabular-nums text-muted-foreground">{coin.symbol}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} ·{" "}
                  {BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing} ·{" "}
                  {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
                </p>
                <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            <Skeleton className="h-10 w-28 rounded-full" />
            <Skeleton className="h-10 w-28 rounded-full" />
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {["Price", "Market Cap", "Supply", "Liquidity"].map((label) => (
            <div key={label} className="rounded-xl border border-border/60 bg-background/45 px-3.5 py-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
              <Skeleton className="h-7 w-24" />
              <Skeleton className="mt-2 h-4 w-28" />
            </div>
          ))}
        </div>
      </section>

      <div className="pharos-card-shell px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="pharos-kicker">Jump to Section</p>
          <span className="text-[11px] text-muted-foreground">{statusLabel}</span>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {["Safety Score", "Overview", "Chart", "Info", "Liquidity"].map((label) => (
            <div
              key={label}
              className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border/60 bg-background px-4 py-2 text-sm text-muted-foreground"
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
