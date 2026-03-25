"use client";

import { Lock, Radar, ShieldCheck } from "lucide-react";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { EmptyStateSurface } from "@/components/empty-state-surface";
import { PresetCard } from "@/components/preset-card";

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
        <p className="pharos-kicker">What appears after you add holdings</p>
        <h3 className="text-base font-semibold text-foreground">
          Weighted grade, radar view, and upstream concentration
        </h3>
      </div>

      <div className="grid gap-3 sm:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-2xl border border-border/60 bg-background/55 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--severity-healthy)]/30 bg-[var(--severity-healthy)]/12 text-lg font-semibold text-emerald-700 dark:text-emerald-300">
              A
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Portfolio grade</p>
              <p className="text-xs text-muted-foreground">Weighted safety score with concentration drag</p>
            </div>
          </div>
          <div className="mt-4 rounded-2xl border border-border/50 bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">Overall score</p>
            <p className="mt-1 font-mono text-2xl text-foreground">84.6</p>
          </div>
        </div>

        <div className="rounded-2xl border border-border/60 bg-background/55 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">Upstream exposure</p>
            <Radar className="h-4 w-4 text-primary/80" />
          </div>
          <div className="mt-4 space-y-3">
            {[
              ["Major centralized stablecoins", "58%"],
              ["U.S. Treasury bills", "27%"],
              ["Crypto collateral", "15%"],
            ].map(([label, value], index) => (
              <div key={label} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono text-foreground">{value}</span>
                </div>
                <div className="h-2 rounded-full bg-muted/30">
                  <div
                    className={`h-2 rounded-full ${index === 0 ? "bg-[var(--chart-primary)]/50" : index === 1 ? "bg-[var(--chart-tertiary)]/40" : "bg-[var(--severity-mild)]/40"}`}
                    style={{ width: value }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PortfolioEmptyState({ presets, logos, onApplyPreset }: PortfolioEmptyStateProps) {
  return (
    <div className="space-y-5">
      <EmptyStateSurface
        eyebrow="Personal Risk View"
        title="Model your stablecoin stack before you commit real size."
        description="Add holdings in USD terms, then Pharos rolls them into one weighted safety grade, a radar view of the weak dimensions, and an upstream exposure breakdown that shows where your risk really lives."
        steps={[
          {
            title: "Add holdings or load a starter mix",
            description: "Build the portfolio manually or start from a reusable template.",
          },
          {
            title: "See the weighted grade instantly",
            description: "The score combines the same report-card inputs used across the site.",
          },
          {
            title: "Check hidden concentration",
            description: "Grouped upstream exposure shows whether several coins still route to the same backing.",
          },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            {presets.slice(0, 3).map((preset) => (
              <button
                key={preset.title}
                type="button"
                onClick={() => onApplyPreset(preset)}
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-border/60 bg-background/60 px-4 py-2 text-sm font-medium text-foreground hover:border-primary/45 hover:bg-primary/8"
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
          const previewItems = preset.holdings
            .slice(0, 4)
            .map(({ coinId }) => {
              const coin = TRACKED_META_BY_ID.get(coinId);
              return coin
                ? {
                    key: coinId,
                    logoName: coin.name,
                    logoSrc: logos?.[coinId],
                  }
                : null;
            })
            .filter((item) => item != null);

          const chips = preset.holdings
            .map(({ coinId, amount }) => {
              const coin = TRACKED_META_BY_ID.get(coinId);
              return coin
                ? {
                    key: coinId,
                    label: `${coin.symbol} ${amount}%`,
                  }
                : null;
            })
            .filter((item) => item != null);

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
