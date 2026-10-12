"use client";

import { Lock, ShieldCheck } from "lucide-react";
import { EmptyStateSurface } from "@/components/empty-state-surface";
import { buildPresetPreview, PresetCard } from "@/components/preset-card";

export interface PortfolioPreset {
  title: string;
  description: string;
  holdings: ReadonlyArray<{ coinId: string; amount: number }>;
}

interface PortfolioEmptyStateProps {
  presets: readonly PortfolioPreset[];
  logos?: Record<string, string>;
  onApplyPreset: (preset: PortfolioPreset) => void;
}

function PortfolioPreview() {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="pharos-label">Example of what appears after you add holdings</p>
        <h3 className="text-base font-semibold text-foreground">
          Weighted safety aggregate and pillar subtotals
        </h3>
      </div>

      {/* Mirrors the loaded result card (src/app/portfolio/client.tsx): an
          aggregate score that is explicitly not a grade, three pillar
          subtotals, and a count of modeled upstream routes. Values are
          illustrative and labelled as such. */}
      <div className="grid gap-4 sm:grid-cols-[0.9fr_1.1fr] sm:gap-0 sm:divide-x sm:divide-border/50">
        <div className="min-w-0 sm:pr-4">
          <p className="text-sm font-medium text-foreground">Weighted V10 safety aggregate</p>
          <p className="mt-1 pharos-numeric text-2xl text-foreground">
            82<span className="text-sm text-muted-foreground">/100</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Portfolio aggregate only, not an asset safety grade</p>
        </div>

        <div className="min-w-0 border-t border-border/50 pt-4 sm:border-t-0 sm:pl-4 sm:pt-0">
          <p className="text-sm font-medium text-foreground">Pillar subtotals</p>
          <div className="mt-4 space-y-3">
            {[
              ["Backing", 86],
              ["Exit", 79],
              ["Economic control", 74],
            ].map(([label, value]) => (
              <div key={label} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="pharos-numeric text-foreground">{value}/100</span>
                </div>
                <div className="h-2 rounded-full bg-muted/30">
                  <div className="h-2 rounded-full bg-[var(--chart-primary)]/50" style={{ width: `${value}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Illustrative values. Your result also counts the modeled upstream exposure routes across your holdings.
      </p>
    </div>
  );
}

export function PortfolioEmptyState({ presets, logos, onApplyPreset }: PortfolioEmptyStateProps) {
  return (
    <div className="space-y-5">
      <EmptyStateSurface
        eyebrow="Personal Risk View"
        title="Model your stablecoin stack before you commit real size."
        description="Add holdings in USD terms, then Pharos rolls them into one weighted safety aggregate with Backing, Exit and Economic control subtotals, next to each holding's own grade."
        steps={[
          {
            title: "Add holdings or load a starter mix",
            description: "Build the portfolio manually or start from a reusable template.",
          },
          {
            title: "See the weighted aggregate instantly",
            description: "The score combines the same report-card inputs used across the site.",
          },
          {
            title: "Check upstream exposure",
            description: "The result counts the modeled upstream exposure routes your holdings share.",
          },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            {presets.slice(0, 3).map((preset) => (
              <button
                key={preset.title}
                type="button"
                onClick={() => onApplyPreset(preset)}
                className="pharos-focus-ring pharos-control-pill min-h-11 gap-2 px-4 text-sm sm:min-h-9"
              >
                <ShieldCheck className="h-4 w-4 text-primary/80" />
                {preset.title}
              </button>
            ))}
          </div>
        }
        preview={<PortfolioPreview />}
        footnote={
          <div className="flex items-start gap-2">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary/85" />
            <span>
              Holdings stay in your browser only. Pharos stores this portfolio in local storage and does not send it to
              the API.
            </span>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {presets.map((preset) => {
          const { previewItems, chips } = buildPresetPreview(preset.holdings, logos, {
            previewCount: 4,
            getCoinId: (holding) => holding.coinId,
            getChipLabel: (holding, coin) => `${coin.symbol} ${holding.amount}%`,
          });

          return (
            <PresetCard
              key={preset.title}
              title={preset.title}
              description={preset.description}
              previewItems={previewItems}
              chips={chips}
              footer="Loads as a $100 reference mix that you can edit line by line."
              ariaLabel={`Load ${preset.title} starting portfolio`}
              onClick={() => onApplyPreset(preset)}
            />
          );
        })}
      </div>
    </div>
  );
}
