"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight, Compass, Search, Ship, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openCommandPalette } from "@/lib/command-palette";
import { useStartHereCallout } from "@/hooks/use-start-here-callout";
import { useVilleTeaser } from "@/hooks/use-ville-teaser";

export function HomepageStartHereCallout() {
  const { isReady, shouldShow, retireCallout } = useStartHereCallout();
  if (!isReady || !shouldShow) return null;
  return <StartHereCallout onOpenStartHere={retireCallout} />;
}

function StartHereCallout({ onOpenStartHere }: { onOpenStartHere: () => void }) {
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
              Start with the route that matches your job
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The Start page takes 2 minutes and routes you to the right surface for what you need: market
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

export function HomepageVilleTeaser() {
  const { isReady, shouldShow, dismiss } = useVilleTeaser();
  if (!isReady || !shouldShow) return null;

  return (
    <section
      aria-label="PharosVille companion"
      // Parchment + brass surface borrowed from PharosVille's pixel-art
      // chrome. Reads as a "fantasy notice pinned to the dashboard" rather
      // than another analytical card. Inset rim mimics a framed parchment.
      className="pharos-card-shell relative overflow-hidden rounded-[1rem] border border-[color:oklch(0.52_0.10_80)] bg-[linear-gradient(135deg,oklch(0.95_0.05_88)_0%,oklch(0.90_0.10_82)_55%,oklch(0.84_0.13_78)_100%)] px-4 py-3.5 text-[oklch(0.18_0.04_60)] dark:border-[color:oklch(0.55_0.09_82)] dark:bg-[linear-gradient(135deg,oklch(0.38_0.05_62)_0%,oklch(0.32_0.04_55)_55%,oklch(0.26_0.03_48)_100%)] dark:text-[oklch(0.94_0.04_86)] sm:px-5"
      style={{
        boxShadow:
          "0 12px 28px oklch(0.20 0.04 50 / 0.30), inset 0 1px 0 oklch(0.99 0.04 88 / 0.55), inset 0 0 0 1px oklch(0.99 0.04 88 / 0.10)",
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,oklch(0.99_0.04_88_/_0.40),transparent_55%),radial-gradient(circle_at_bottom_right,oklch(0.55_0.13_60_/_0.20),transparent_60%)] dark:bg-[radial-gradient(circle_at_top_left,oklch(0.65_0.10_84_/_0.18),transparent_55%),radial-gradient(circle_at_bottom_right,oklch(0.30_0.04_44_/_0.35),transparent_60%)]"
        aria-hidden="true"
      />
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border text-[oklch(0.22_0.05_50)] dark:text-[oklch(0.18_0.04_60)]"
            style={{
              borderColor: "oklch(0.45 0.09 80)",
              background:
                "radial-gradient(circle at 32% 28%, oklch(0.97 0.05 88) 0%, oklch(0.82 0.16 80) 55%, oklch(0.55 0.13 60) 100%)",
              boxShadow:
                "inset 0 1px 0 oklch(1 0 0 / 0.40), inset 0 -1px 0 oklch(0.20 0.04 40 / 0.35), 0 1px 2px oklch(0.20 0.04 40 / 0.20)",
            }}
          >
            <Ship className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="pharos-kicker text-[oklch(0.42_0.10_60)] dark:text-[oklch(0.84_0.12_84)]">
              Immersive data visualization
            </p>
            <p className="text-sm leading-snug">
              <span className="font-semibold">PharosVille:</span>{" "}
              <span className="text-[oklch(0.26_0.04_50)] dark:text-[oklch(0.92_0.04_86)]">
                a pixel-art harbor where the Pharos data comes to life, with chains as harbors, stablecoins as ships, and DEWS alert tiers as sea zones.
              </span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            asChild
            variant="outline"
            className="h-9 rounded-full border-[color:oklch(0.42_0.09_70)] bg-[linear-gradient(180deg,oklch(0.94_0.07_88),oklch(0.80_0.16_80))] px-4 text-sm font-semibold text-[oklch(0.18_0.04_60)] shadow-[inset_0_1px_0_oklch(1_0_0_/_0.40),0_2px_0_oklch(0.30_0.05_40_/_0.35)] hover:border-[color:oklch(0.32_0.07_60)] hover:bg-[linear-gradient(180deg,oklch(0.96_0.07_88),oklch(0.84_0.16_80))] hover:text-[oklch(0.18_0.04_60)] dark:border-[color:oklch(0.58_0.10_82)] dark:bg-[linear-gradient(180deg,oklch(0.86_0.13_82),oklch(0.70_0.15_72))] dark:text-[oklch(0.18_0.04_60)] dark:hover:border-[color:oklch(0.78_0.16_84)] dark:hover:bg-[linear-gradient(180deg,oklch(0.90_0.13_84),oklch(0.74_0.15_72))] dark:hover:text-[oklch(0.18_0.04_60)]"
          >
            <a
              href="https://pharosville.pharos.watch/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Explore PharosVille (opens in new tab)"
            >
              Explore PharosVille
              <ArrowUpRight className="h-4 w-4" />
            </a>
          </Button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss PharosVille teaser"
            className="pharos-focus-ring inline-flex size-9 items-center justify-center rounded-full text-[oklch(0.30_0.05_50_/_0.65)] transition-colors hover:bg-[oklch(0.99_0.04_88_/_0.40)] hover:text-[oklch(0.18_0.04_60)] dark:text-[oklch(0.92_0.04_86_/_0.7)] dark:hover:bg-[oklch(0.55_0.08_60_/_0.30)] dark:hover:text-[oklch(0.96_0.04_86)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
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
