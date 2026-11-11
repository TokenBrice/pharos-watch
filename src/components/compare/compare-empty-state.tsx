"use client";

import { ArrowRight } from "lucide-react";
import { buildPresetPreview, PresetCard } from "@/components/preset-card";
import { EmptyStateSurface } from "@/components/empty-state-surface";
import type { ComparePreset } from "@/lib/compare-types";
import { getPresetCoins } from "@/lib/compare-config";

interface CompareEmptyStateProps {
  presets: readonly ComparePreset[];
  logos?: Record<string, string>;
  onApplyPreset: (preset: ComparePreset) => void;
}

const COMPARE_OUTPUTS = [
  { title: "Market cap history", detail: "Normalized overlays across the set" },
  { title: "Peg and supply deltas", detail: "Deviation, 7d supply change, liquidity score" },
  { title: "Safety Score radar", detail: "Pillar-by-pillar view of every selected coin" },
] as const;

function ComparePreview() {
  return (
    <div className="min-w-0 space-y-3">
      <div>
        <p className="pharos-label">No comparison yet</p>
        <p className="mt-1 text-sm font-medium text-foreground">Select at least two stablecoins to see</p>
      </div>
      <ul className="divide-y divide-border/50">
        {COMPARE_OUTPUTS.map((output) => (
          <li key={output.title} className="py-2.5">
            <p className="text-sm font-medium text-foreground">{output.title}</p>
            <p className="text-xs text-muted-foreground">{output.detail}</p>
          </li>
        ))}
      </ul>
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
        preview={<ComparePreview />}
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="pharos-label">Preset packs</p>
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
