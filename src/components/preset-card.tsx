"use client";

import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface PresetCardPreviewItem {
  key: string;
  logoName: string;
  logoSrc?: string;
}

export interface PresetCardChip {
  key: string;
  label: string;
}

interface PresetCardProps {
  title: string;
  description: string;
  previewItems: readonly PresetCardPreviewItem[];
  chips: readonly PresetCardChip[];
  footer: string;
  ariaLabel: string;
  onClick: () => void;
  featured?: boolean;
}

export function buildPresetPreview<T>(
  items: readonly T[],
  logos: Record<string, string> | undefined,
  options: {
    previewCount: number;
    getCoinId: (item: T) => string;
    getChipLabel: (item: T, coin: { symbol: string; name: string }) => string;
  },
): { previewItems: PresetCardPreviewItem[]; chips: PresetCardChip[] } {
  const previewItems = items
    .slice(0, options.previewCount)
    .map((item) => {
      const coinId = options.getCoinId(item);
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

  const chips = items
    .map((item) => {
      const coinId = options.getCoinId(item);
      const coin = TRACKED_META_BY_ID.get(coinId);
      return coin
        ? {
            key: coinId,
            label: options.getChipLabel(item, coin),
          }
        : null;
    })
    .filter((item) => item != null);

  return { previewItems, chips };
}

export function PresetCard({
  title,
  description,
  previewItems,
  chips,
  footer,
  ariaLabel,
  onClick,
  featured = false,
}: PresetCardProps) {
  return (
    <Card
      className={`pharos-focus-ring cursor-pointer border-border/70 transition-[border-color,background-color,transform,box-shadow] hover:border-primary/40 hover:bg-accent/35 hover:shadow-[0_16px_34px_oklch(0_0_0_/0.16)] ${featured ? "bg-card/92" : "bg-card/75"}`}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="text-sm leading-relaxed">{description}</CardDescription>
          </div>
          <div className="flex -space-x-2">
            {previewItems.map((item) => (
              <span key={item.key} className="rounded-full ring-2 ring-card">
                <StablecoinLogo src={item.logoSrc} name={item.logoName} size={24} />
              </span>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="rounded-full border border-border/60 bg-background/65 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
            >
              {chip.label}
            </span>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{footer}</p>
      </CardContent>
    </Card>
  );
}
