"use client";

import { StablecoinLogo } from "@/components/stablecoin-logo";
import { StablecoinIdentityTransition } from "@/components/view-transitions";
import { STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE } from "@/components/stablecoin-detail/constants";
import { BackToSource } from "@/components/back-to-source";
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
    <div>
      <BackToSource className="mb-2" />
      <section className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex items-start gap-3">
              {/* The loading shell is what a row → dossier navigation commits
                  first, so it carries the identity morph's dossier end until
                  the hydrated header takes over. */}
              <StablecoinIdentityTransition id={coin.id}>
                <div className="flex shrink-0 items-center gap-3">
                  <StablecoinLogo src={logoSrc} name={coin.name} size={STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE} />
                </div>
              </StablecoinIdentityTransition>
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
          {["Price", "Market cap", "Supply", "Liquidity"].map((label) => (
            <div key={label} className="pharos-inset px-3.5 py-3">
              <p className="pharos-label mb-1">{label}</p>
              <Skeleton className="h-7 w-24" />
              <Skeleton className="mt-2 h-4 w-28" />
            </div>
          ))}
        </div>
      </section>

      {/* Mirrors the ready page's scrollspy pill bar (labels from
          `DETAIL_SECTIONS` in detail-content.tsx; the conditional "How it
          breaks" pill is omitted) so a slow load neither shifts nor renames. */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 lg:justify-center">
        <div className="flex min-w-0 items-center gap-3">
          <span className="pharos-label hidden shrink-0 sm:inline">Jump to</span>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {["Risk", "Context", "Market", "Activity", "History", "Explore"].map((label) => (
              <div
                key={label}
                className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border/60 bg-background px-4 py-2 text-sm text-muted-foreground"
              >
                {label}
              </div>
            ))}
          </div>
        </div>
        <span className="text-2xs text-muted-foreground">{statusLabel}</span>
      </div>
    </div>
  );
}
