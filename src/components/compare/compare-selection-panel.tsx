"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Share2, X, Download, type LucideIcon } from "lucide-react";
import { CoinSelector } from "@/components/coin-selector";
import { CompareEmptyState } from "@/components/compare-empty-state";
import type { useCompareSelection } from "@/hooks/use-compare-selection";
import type { useCompareShareActions } from "@/hooks/use-compare-share-actions";
import { COMPARISON_PRESETS, MAX_COMPARE_COINS, getPresetCoins } from "@/lib/compare-config";
import { buildCompareSelectionInsights } from "@/lib/compare-selection-insights";
import { stablecoinLabel } from "@/lib/stablecoin-label";
import type { CoinOption } from "@/lib/compare-types";
import { buildStablecoinUrl } from "@shared/lib/urls";

const COMPARE_SHARE_BUTTON_CLASS =
  "pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 sm:min-h-0 sm:py-1.5";

function CompareShareButton({
  icon: Icon,
  label,
  title,
  ariaLabel,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  ariaLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={COMPARE_SHARE_BUTTON_CLASS}
      aria-label={ariaLabel}
      title={title}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

interface CompareMobileSelectionControlsProps {
  selectedIds: readonly string[];
  selectedCoins: readonly (CoinOption | null)[];
  coinOptions: CoinOption[];
  logos?: Record<string, string>;
  disabledIds: Set<string>;
  onSelect: (slotIndex: number, coin: CoinOption) => void;
  onRemove: (slotIndex: number) => void;
  onClear: () => void;
}

function CompareMobileSelectionControls({
  selectedIds,
  selectedCoins,
  coinOptions,
  logos,
  disabledIds,
  onSelect,
  onRemove,
  onClear,
}: CompareMobileSelectionControlsProps) {
  const mobileAddSlotIndex = selectedIds.length;

  return (
    <div className="space-y-3 sm:hidden">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="pharos-label">Selection</p>
          <p className="text-xs text-muted-foreground">
            {selectedIds.length}/{MAX_COMPARE_COINS} selected
          </p>
        </div>
        {selectedIds.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
      </div>
      {selectedCoins.map((coin, index) =>
        coin ? (
          <CoinSelector
            key={coin.id}
            coins={coinOptions}
            selected={coin}
            logos={logos}
            disabledIds={disabledIds}
            onSelect={(selectedCoin) => onSelect(index, selectedCoin)}
            onRemove={() => onRemove(index)}
          />
        ) : null,
      )}
      {selectedIds.length < MAX_COMPARE_COINS ? (
        <CoinSelector
          coins={coinOptions}
          selected={null}
          logos={logos}
          disabledIds={disabledIds}
          onSelect={(selectedCoin) => onSelect(mobileAddSlotIndex, selectedCoin)}
          onRemove={() => {}}
        />
      ) : null}
    </div>
  );
}

export function CompareSelectionPanel({ selection, share, logos }: {
  selection: ReturnType<typeof useCompareSelection>;
  share: ReturnType<typeof useCompareShareActions>;
  logos: Record<string, string>;
}) {
  const { selectedIds, selectedCoins, coinOptions, disabledIds, handleSelect, handleRemove, setSelectedIds, applyPreset } = selection;
  const { toast, shareLoading, handleTwitterShare, handleWebShare, handleDownload } = share;
  const activeSelectionLabel = selectedCoins
    .filter((coin): coin is NonNullable<(typeof selectedCoins)[number]> => coin !== null)
    .map(stablecoinLabel)
    .join(" vs ");
  const selectionInsights = useMemo(
    () => buildCompareSelectionInsights({ selectedIds }),
    [selectedIds],
  );
  // Render selector slots (filled slots + empty slots up to MAX_COINS)
  const slots = [];
  for (let i = 0; i < MAX_COMPARE_COINS; i++) {
    const coin = selectedCoins[i] ?? null;
    slots.push(
      <CoinSelector
        key={i}
        coins={coinOptions}
        selected={coin}
        logos={logos}
        disabledIds={disabledIds}
        onSelect={(c) => handleSelect(i, c)}
        onRemove={() => handleRemove(i)}
      />,
    );
  }

  return (
    <>
      {selectedIds.length >= 2 ? (
        <div className="pharos-card-shell px-4 py-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="pharos-label">Active comparison</p>
                <p className="break-words text-sm text-foreground">
                  {activeSelectionLabel}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Shareable link · up to {MAX_COMPARE_COINS} assets · live data
              </p>
            </div>
            {selectionInsights ? (
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="pharos-inset px-3.5 py-3">
                  <p className="pharos-label">How to read this set</p>
                  {selectionInsights.lens ? (
                    <p className="mt-1 text-sm text-foreground">{selectionInsights.lens}</p>
                  ) : null}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {selectionInsights.cohort} {selectionInsights.structure}
                  </p>
                </div>
                <div className="pharos-inset px-3.5 py-3">
                  <p className="pharos-label">Jump to detail</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectionInsights.links.map((coin) => (
                      <Link
                        key={coin.id}
                        href={buildStablecoinUrl(coin.id)}
                        className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-foreground/20 hover:bg-accent lg:min-h-9"
                      >
                        {stablecoinLabel(coin)} detail
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {selectedIds.length >= 2 && (
        <div className="flex items-center justify-end gap-2">
          {toast && <span className="text-xs text-muted-foreground animate-fade-in">{toast}</span>}
          <CompareShareButton
            icon={X}
            label="Tweet"
            title="Share on Twitter/X"
            ariaLabel="Share comparison on Twitter"
            disabled={shareLoading}
            onClick={handleTwitterShare}
          />
          <CompareShareButton
            icon={Share2}
            label="Share"
            title="Share comparison"
            ariaLabel="Share comparison link or image"
            disabled={shareLoading}
            onClick={handleWebShare}
          />
          <CompareShareButton
            icon={Download}
            label="Image"
            title="Download comparison image"
            ariaLabel="Download comparison as image"
            disabled={shareLoading}
            onClick={handleDownload}
          />
        </div>
      )}
      <CompareMobileSelectionControls
        selectedIds={selectedIds}
        selectedCoins={selectedCoins}
        coinOptions={coinOptions}
        logos={logos}
        disabledIds={disabledIds}
        onSelect={handleSelect}
        onRemove={handleRemove}
        onClear={() => setSelectedIds(() => [])}
      />
      <div className="hidden gap-3 sm:grid sm:grid-cols-3 lg:grid-cols-5">{slots}</div>

      {selectedIds.length < 2 && (
        <CompareEmptyState
          presets={COMPARISON_PRESETS}
          logos={logos}
          onApplyPreset={(preset) => applyPreset(getPresetCoins(preset), preset.title)}
        />
      )}
    </>
  );
}
