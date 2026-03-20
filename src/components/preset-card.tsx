"use client";

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
