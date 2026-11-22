"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, Link2, RotateCcw, X } from "lucide-react";
import { CoinSelector } from "@/components/coin-selector";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { CoinOption } from "@/lib/compare-types";
import type { ExposureShareStatus } from "./dependency-exposure-workspace";
import dependencyMapContent from "./content.json";

const content = dependencyMapContent.exposure;

export interface ExposureRootOption {
  id: string;
  label: string;
  name?: string;
  symbol?: string;
}

export interface QuickTraceHub {
  id: string;
  label: string;
}

export function DependencyExposureControls({
  roots,
  options,
  quickTraceHubs,
  logos,
  shareStatus = "idle",
  onAdd,
  onRemove,
  onReset,
  onShare,
}: {
  roots: readonly string[];
  options: readonly ExposureRootOption[];
  quickTraceHubs?: readonly QuickTraceHub[];
  logos?: Record<string, string>;
  shareStatus?: ExposureShareStatus;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onReset: () => void;
  onShare: () => void;
}) {
  const [draft, setDraft] = useState<CoinOption | null>(null);
  const rootSet = useMemo(() => new Set(roots), [roots]);
  const coinOptions = useMemo<CoinOption[]>(
    () =>
      options.map((option) => ({
        id: option.id,
        name: option.name ?? option.label,
        symbol: option.symbol ?? option.label,
      })),
    [options],
  );
  const availableQuickHubs = useMemo(
    () => (quickTraceHubs ?? []).filter((hub) => !rootSet.has(hub.id)),
    [quickTraceHubs, rootSet],
  );

  return (
    <aside className="pharos-card-shell space-y-4 p-4" aria-label="Exposure roots">
      <p className="text-xs leading-relaxed text-muted-foreground">{content.description}</p>

      <div className="space-y-2">
        <h3 className="pharos-label">{content.roots}</h3>
        {roots.length ? (
          <ul className="space-y-1.5">
            {roots.map((id) => {
              const label = options.find((option) => option.id === id)?.label ?? id;
              return (
                <li
                  key={id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/25 px-2.5 py-1.5 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <StablecoinLogo src={logos?.[id]} name={label} size={18} />
                    <span className="truncate font-medium text-foreground">{label}</span>
                  </span>
                  <button
                    type="button"
                    className="pharos-focus-ring inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => onRemove(id)}
                    aria-label={`Remove root ${id}`}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{content.empty}</p>
        )}
      </div>

      {availableQuickHubs.length > 0 ? (
        <div className="space-y-1.5">
          <p className="pharos-label">Major hubs</p>
          <div className="flex flex-wrap gap-1.5">
            {availableQuickHubs.map((hub) => (
              <button
                key={hub.id}
                type="button"
                onClick={() => onAdd(hub.id)}
                className="pharos-focus-ring pharos-control-pill inline-flex min-h-9 items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-foreground sm:min-h-7"
              >
                <StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={16} />
                <span>{hub.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <p id="exposure-root-picker-label" className="block text-xs font-medium text-foreground">
          {content.add}
        </p>
        <div role="group" aria-labelledby="exposure-root-picker-label">
          <CoinSelector
            coins={coinOptions}
            selected={draft}
            logos={logos}
            disabledIds={rootSet}
            onSelect={(coin) => setDraft(coin)}
            onRemove={() => setDraft(null)}
          />
        </div>
        <button
          type="button"
          disabled={!draft}
          className="pharos-focus-ring pharos-control-pill min-h-11 w-full justify-center px-3 text-sm font-medium text-foreground disabled:opacity-50 sm:min-h-9"
          onClick={() => {
            if (draft) {
              onAdd(draft.id);
              setDraft(null);
            }
          }}
        >
          {content.trace}
        </button>
      </div>

      <div className="space-y-1.5 border-t border-border/50 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3 text-xs font-medium text-foreground sm:min-h-8"
            onClick={onShare}
          >
            {shareStatus === "copied" ? (
              <Check className="h-3.5 w-3.5 text-state-positive" aria-hidden="true" />
            ) : (
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {shareStatus === "copied" ? "Link copied" : content.share}
          </button>
          <button
            type="button"
            className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground hover:text-foreground sm:min-h-8"
            onClick={onReset}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {content.reset}
          </button>
        </div>
        {shareStatus !== "idle" ? (
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {shareStatus === "copied" ? "Exposure link copied to clipboard." : "Could not copy exposure link."}
          </p>
        ) : null}
      </div>

      <details className="border-t border-border/50 pt-2 text-xs">
        <summary className="pharos-focus-ring min-h-11 cursor-pointer py-2 font-medium text-muted-foreground hover:text-foreground sm:min-h-8">
          {content.history}
        </summary>
        <p className="mt-1 text-muted-foreground">{content.historyDescription}</p>
        <Link href={content.historyLink.href} className="pharos-focus-ring mt-1 inline-flex min-h-11 items-center text-brand-accent-text underline-offset-2 hover:underline sm:min-h-8">
          {content.historyLink.label}
        </Link>
      </details>
    </aside>
  );
}
