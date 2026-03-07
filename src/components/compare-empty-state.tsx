"use client";

import { ArrowRight, LockKeyhole, Waves } from "lucide-react";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { EmptyStateSurface } from "@/components/empty-state-surface";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface ComparePreset {
  title: string;
  description: string;
  coins: readonly string[];
}

interface CompareEmptyStateProps {
  presets: readonly ComparePreset[];
  logos?: Record<string, string>;
  onApplyPreset: (preset: ComparePreset) => void;
}

function ComparePreview({
  logos,
  featuredCoins,
}: {
  logos?: Record<string, string>;
  featuredCoins: readonly string[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="pharos-kicker">Preview</p>
          <p className="mt-1 text-sm font-medium text-foreground">Comparison output unlocks after two selections</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-3 py-1 text-xs text-muted-foreground">
          <LockKeyhole className="h-3.5 w-3.5" />
          Share stays hidden until then
        </span>
      </div>

      <div className="rounded-2xl border border-border/60 bg-background/45 p-4">
        <div className="flex items-center gap-2">
          {featuredCoins.map((coinId) => {
            const coin = TRACKED_META_BY_ID.get(coinId);
            if (!coin) return null;
            return (
              <div
                key={coinId}
                className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-xs text-muted-foreground"
              >
                <StablecoinLogo src={logos?.[coinId]} name={coin.name} size={20} />
                <span className="font-medium text-foreground">{coin.symbol}</span>
              </div>
            );
          })}
        </div>

        <div className="mt-4 grid gap-3">
          <div className="rounded-2xl border border-border/50 bg-muted/20 p-3">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">Market cap history</p>
              <span className="text-xs text-muted-foreground">Normalized overlays</span>
            </div>
            <div className="flex h-24 items-end gap-2">
              <div className="h-12 flex-1 rounded-t-xl bg-cyan-500/35" />
              <div className="h-20 flex-1 rounded-t-xl bg-blue-500/35" />
              <div className="h-16 flex-1 rounded-t-xl bg-emerald-500/30" />
              <div className="h-10 flex-1 rounded-t-xl bg-amber-500/30" />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1.05fr_0.95fr]">
            <div className="rounded-2xl border border-border/50 bg-muted/20 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">Quick deltas</p>
                <span className="text-xs text-muted-foreground">peg, supply, liquidity</span>
              </div>
              <div className="space-y-2">
                {["Peg deviation", "7d supply", "Liquidity score"].map((label, index) => (
                  <div
                    key={label}
                    className="flex items-center justify-between rounded-xl border border-border/40 bg-background/65 px-3 py-2"
                  >
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <span
                      className={`text-xs font-mono ${index === 0 ? "text-emerald-400" : index === 1 ? "text-cyan-300" : "text-amber-300"}`}
                    >
                      {index === 0 ? "-0.02%" : index === 1 ? "+2.4%" : "78/100"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-border/50 bg-muted/20 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">Safety score radar</p>
                <Waves className="h-4 w-4 text-primary/80" />
              </div>
              <div className="relative mx-auto mt-2 flex h-32 w-32 items-center justify-center rounded-full border border-dashed border-border/60">
                <div className="absolute inset-4 rounded-full border border-border/50" />
                <div className="absolute inset-8 rounded-full border border-border/40" />
                <div className="h-14 w-14 rounded-full bg-primary/12" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComparePresetCard({
  preset,
  logos,
  onApplyPreset,
  featured = false,
}: {
  preset: ComparePreset;
  logos?: Record<string, string>;
  onApplyPreset: (preset: ComparePreset) => void;
  featured?: boolean;
}) {
  return (
    <Card
      className={`cursor-pointer border-border/70 transition-[border-color,background-color,transform,box-shadow] hover:border-primary/40 hover:bg-accent/35 hover:shadow-[0_16px_34px_oklch(0_0_0_/0.16)] ${featured ? "bg-card/92" : "bg-card/72"}`}
      role="button"
      tabIndex={0}
      aria-label={`Apply ${preset.title} preset`}
      onClick={() => onApplyPreset(preset)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onApplyPreset(preset);
        }
      }}
    >
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{preset.title}</CardTitle>
            <CardDescription className="text-sm leading-relaxed">{preset.description}</CardDescription>
          </div>
          <div className="flex -space-x-2">
            {preset.coins.slice(0, featured ? 4 : 3).map((coinId) => {
              const coin = TRACKED_META_BY_ID.get(coinId);
              if (!coin) return null;
              return (
                <span key={coinId} className="rounded-full ring-2 ring-card">
                  <StablecoinLogo src={logos?.[coinId]} name={coin.name} size={24} />
                </span>
              );
            })}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="flex flex-wrap gap-2">
          {preset.coins.map((coinId) => {
            const coin = TRACKED_META_BY_ID.get(coinId);
            if (!coin) return null;
            return (
              <span
                key={coinId}
                className="rounded-full border border-border/60 bg-background/65 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
              >
                {coin.symbol}
              </span>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Loads directly into the comparison table without auto-populating on first visit.
        </p>
      </CardContent>
    </Card>
  );
}

export function CompareEmptyState({ presets, logos, onApplyPreset }: CompareEmptyStateProps) {
  const featured = presets.slice(0, 3);
  const secondary = presets.slice(3);

  return (
    <div className="space-y-5">
      <EmptyStateSurface
        eyebrow="Launch The Comparison"
        title="Pick a small stack, then let the dashboard do the side-by-side work."
        description="Use the selector slots above for custom mixes, or start with a preset pack below. The comparison view opens with market-cap history, peg behavior, liquidity, and safety context once you have at least two stablecoins selected."
        steps={[
          {
            title: "Choose 2 to 5 coins",
            description: "Mix majors, DeFi names, or non-USD pegs without leaving the page.",
          },
          {
            title: "Start with a preset",
            description: "Jump into common comparison sets instead of building from scratch.",
          },
          {
            title: "Share when ready",
            description: "Tweet, copy, or export the view once the panel has real data.",
          },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            {featured.map((preset) => (
              <button
                key={preset.title}
                type="button"
                onClick={() => onApplyPreset(preset)}
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-border/60 bg-background/60 px-4 py-2 text-sm font-medium text-foreground hover:border-primary/45 hover:bg-primary/8"
              >
                {preset.title}
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        }
        preview={
          <ComparePreview logos={logos} featuredCoins={featured.flatMap((preset) => preset.coins).slice(0, 4)} />
        }
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="pharos-kicker">Preset Packs</p>
            <h3 className="mt-1 text-lg font-semibold text-foreground">Jump straight into common comparison angles</h3>
          </div>
          <span className="text-xs text-muted-foreground">{presets.length} packs</span>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          {featured.map((preset) => (
            <ComparePresetCard
              key={preset.title}
              preset={preset}
              logos={logos}
              featured
              onApplyPreset={onApplyPreset}
            />
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {secondary.map((preset) => (
            <ComparePresetCard key={preset.title} preset={preset} logos={logos} onApplyPreset={onApplyPreset} />
          ))}
        </div>
      </div>
    </div>
  );
}
