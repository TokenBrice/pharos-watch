"use client";

import Link from "next/link";
import { ArrowRight, Compass, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openCommandPalette } from "@/lib/command-palette";

export function StartHereCallout({ onOpenStartHere }: { onOpenStartHere: () => void }) {
  return (
    <section
      className="pharos-card-shell overflow-hidden border border-border/40 px-4 py-4 sm:px-5"
      style={{ background: 'var(--surface-onboarding-gradient)', boxShadow: 'var(--elevation-rest)' }}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 text-[var(--brand-accent)]">
            <Compass className="h-4 w-4" aria-hidden="true" />
            <p className="pharos-kicker text-[var(--brand-accent)]">New to Pharos?</p>
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              Start with the route that matches your job, not the full feature list.
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The /start/ page explains what the core signals mean and points you to the right surface for market
              monitoring, single-coin research, yield, comparison, or alerts.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button asChild className="h-10 rounded-full bg-primary px-5 text-primary-foreground hover:bg-primary/90">
            <Link href="/start/" onClick={onOpenStartHere}>
              Start Here
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-full px-5"
            onClick={openCommandPalette}
          >
            <Search className="h-4 w-4" />
            Search a coin
          </Button>
        </div>
      </div>
    </section>
  );
}

export function HomepageSectionBand({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1.5">
      <p className="pharos-kicker">{eyebrow}</p>
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
