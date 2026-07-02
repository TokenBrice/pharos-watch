"use client";

import { ArrowRight, LockKeyhole, Waves } from "lucide-react";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildPresetPreview, PresetCard } from "@/components/preset-card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { EmptyStateSurface } from "@/components/empty-state-surface";
import type { ComparePreset } from "@/lib/compare-types";
import { getPresetCoins } from "@/lib/compare-config";

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
    <div className="min-w-0 space-y-4">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="pharos-kicker">Preview</p>
          <p className="mt-1 text-sm font-medium text-foreground">Comparison output unlocks after two selections</p>
        </div>
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-3 py-1 text-xs text-muted-foreground">
          <LockKeyhole className="h-3.5 w-3.5" />
          <span className="min-w-0 truncate">Share stays hidden until then</span>
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {featuredCoins.map((coinId) => {
          const coin = TRACKED_META_BY_ID.get(coinId);
          if (!coin) return null;
          return (
            <div
              key={coinId}
              className="inline-flex min-w-0 items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-xs text-muted-foreground"
            >
              <StablecoinLogo src={logos?.[coinId]} name={coin.name} size={20} />
              <span className="font-medium text-foreground">{coin.symbol}</span>
            </div>
          );
        })}
      </div>

      <div className="min-w-0 divide-y divide-border/50">
        <div className="pb-4">
          <div className="mb-3 flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium text-foreground">Market cap history</p>
            <span className="text-xs text-muted-foreground">Normalized overlays</span>
          </div>
          <div className="flex h-24 items-end gap-2">
            <div className="h-24 flex-1 rounded-lg border-2 border-dashed border-border/40" />
          </div>
        </div>

        <div className="grid gap-4 pt-4 sm:grid-cols-[1.05fr_0.95fr] sm:gap-6">
          <div className="min-w-0">
            <div className="mb-2 flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm font-medium text-foreground">Quick deltas</p>
              <span className="text-xs text-muted-foreground">peg, supply, liquidity</span>
            </div>
            <div className="divide-y divide-border/40">
              {["Peg deviation", "7d supply", "Liquidity score"].map((label, index) => (
                <div key={label} className="flex items-center justify-between py-2">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <span
                    className="text-xs pharos-numeric text-muted-foreground"
                  >
                    {index === 0 ? "-0.02%" : index === 1 ? "+2.4%" : "78/100"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="min-w-0">
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
  const coins = getPresetCoins(preset);
  const { previewItems, chips } = buildPresetPreview(coins, logos, {
    previewCount: featured ? 4 : 3,
    getCoinId: (coinId) => coinId,
    getChipLabel: (_coinId, coin) => coin.symbol,
  });

  return (
    <PresetCard
      title={preset.title}
      description={preset.description}
      previewItems={previewItems}
      chips={chips}
      footer=""
      ariaLabel={`Apply ${preset.title} preset`}
      featured={featured}
      onClick={() => onApplyPreset(preset)}
    />
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
                className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-2 px-4 py-2 text-sm font-medium text-foreground"
              >
                {preset.title}
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        }
        preview={
          <ComparePreview logos={logos} featuredCoins={featured.flatMap(getPresetCoins).slice(0, 4)} />
        }
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="pharos-kicker">Preset Packs</p>
            <h3 className="mt-1 text-lg font-semibold text-foreground">Jump straight into common comparison angles</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Each pack loads directly into the comparison table without auto-populating on first visit.
            </p>
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
