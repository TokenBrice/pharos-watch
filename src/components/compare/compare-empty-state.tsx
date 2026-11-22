"use client";

import { buildPresetPreview, PresetCard } from "@/components/preset-card";
import { useWatchlist } from "@/hooks/use-watchlist";
import type { ComparePreset } from "@/lib/compare-types";
import { getPresetCoins, isComparePresetAvailable } from "@/lib/compare-config";

interface CompareEmptyStateProps {
  presets: readonly ComparePreset[];
  logos?: Record<string, string>;
  onApplyPreset: (preset: ComparePreset) => void;
}

function ComparePresetCard({
  preset,
  watchlistIds,
  logos,
  onApplyPreset,
  featured = false,
}: {
  preset: ComparePreset;
  watchlistIds: readonly string[];
  logos?: Record<string, string>;
  onApplyPreset: (preset: ComparePreset) => void;
  featured?: boolean;
}) {
  const coins = getPresetCoins(preset, watchlistIds);
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
  const { ids: watchlistIds } = useWatchlist();
  const visiblePresets = presets.filter((preset) => isComparePresetAvailable(preset, watchlistIds));
  const featured = visiblePresets.slice(0, 3);
  const secondary = visiblePresets.slice(3);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="pharos-label">1-click preset packs</p>
          <h2 className="mt-0.5 text-base font-semibold text-foreground">
            Start with a peer set, or pick 2 to 5 coins above
          </h2>
        </div>
        <span className="text-xs text-muted-foreground">{visiblePresets.length} packs</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {featured.map((preset) => (
          <ComparePresetCard
            key={preset.title}
            preset={preset}
            watchlistIds={watchlistIds}
            logos={logos}
            featured
            onApplyPreset={onApplyPreset}
          />
        ))}
      </div>

      {secondary.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {secondary.map((preset) => (
            <ComparePresetCard
              key={preset.title}
              preset={preset}
              watchlistIds={watchlistIds}
              logos={logos}
              onApplyPreset={onApplyPreset}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
