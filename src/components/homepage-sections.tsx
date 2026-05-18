"use client";

import Link from "next/link";
import { ArrowRight, Compass, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openCommandPalette } from "@/lib/command-palette";
import { useStartHereCallout } from "@/hooks/use-start-here-callout";

export function HomepageStartHereCallout() {
  const { isReady, shouldShow, retireCallout } = useStartHereCallout();
  if (!isReady || !shouldShow) return null;
  return <StartHereCallout onOpenStartHere={retireCallout} />;
}

function StartHereCallout({ onOpenStartHere }: { onOpenStartHere: () => void }) {
  return (
    <section
      className="pharos-card-shell overflow-hidden border border-border/40 px-3 py-3 sm:px-5 sm:py-4"
      style={{ background: 'var(--surface-onboarding-gradient)', boxShadow: 'var(--elevation-rest)' }}
    >
      <div className="flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5 sm:space-y-2">
          <div className="flex items-center gap-2 text-[var(--brand-accent)]">
            <Compass className="h-4 w-4" aria-hidden="true" />
            <p className="pharos-kicker text-[var(--brand-accent)]">New to Pharos?</p>
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight text-foreground sm:text-xl">
              Start with the route that matches your job
            </h2>
            <p className="line-clamp-2 text-xs leading-snug text-muted-foreground sm:line-clamp-none sm:text-sm sm:leading-relaxed">
              The Start page takes 2 minutes and routes you to the right surface for what you need: market
              monitoring, single-coin research, yield, comparison, or alerts.
            </p>
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Button asChild className="h-10 rounded-full bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90 sm:px-5 sm:text-sm">
            <Link href="/start/" onClick={onOpenStartHere}>
              Start Here
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-full px-3 text-xs sm:px-5 sm:text-sm"
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
