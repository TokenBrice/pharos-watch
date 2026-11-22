"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Briefcase,
  Check,
  Download,
  ExternalLink,
  Link2,
  Share2,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { CoinStateChip } from "@/components/coin-state-chip";
import { CompareCoinSlot } from "@/components/compare/compare-coin-slot";
import { CompareEmptyState } from "@/components/compare/compare-empty-state";
import type { useCompareSelection } from "@/hooks/use-compare-selection";
import type { useCompareShareActions } from "@/hooks/use-compare-share-actions";
import { copyText } from "@/lib/clipboard";
import { COMPARISON_PRESETS, MAX_COMPARE_COINS, getPresetCoins } from "@/lib/compare-config";
import { buildCompareSelectionInsights } from "@/lib/compare-selection-insights";
import { mergeCoinsParam } from "@/lib/portfolio-codec";
import { encodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";
import { stablecoinLabel } from "@/lib/stablecoin-label";
import type { CoinOption } from "@/lib/compare-types";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { CoinState } from "@shared/lib/coin-state";

const COMPARE_ACTION_BUTTON_CLASS =
  "pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 sm:min-h-8";

function CompareActionButton({
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
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={COMPARE_ACTION_BUTTON_CLASS}
      aria-label={ariaLabel}
      title={title}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

interface CompareMobileSelectionControlsProps {
  selectedIds: readonly string[];
  selectedCoins: readonly (CoinOption | null)[];
  coinOptions: CoinOption[];
  coinStatesById?: ReadonlyMap<string, readonly CoinState[]>;
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
  coinStatesById,
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
            className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Clear all
          </button>
        ) : null}
      </div>
      {selectedCoins.map((coin, index) => {
        if (!coin) return null;
        // The matrix shows one column at a time on a phone, so each chip carries its coin's state.
        const state = coinStatesById?.get(coin.id)?.[0];
        return (
          <div key={coin.id} className="space-y-1">
            <CompareCoinSlot
              coins={coinOptions}
              selected={coin}
              logos={logos}
              disabledIds={disabledIds}
              onSelect={(selectedCoin) => onSelect(index, selectedCoin)}
              onRemove={() => onRemove(index)}
            />
            {state ? <CoinStateChip state={state} showDetail /> : null}
          </div>
        );
      })}
      {selectedIds.length < MAX_COMPARE_COINS ? (
        <CompareCoinSlot
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

export function CompareSelectionPanel({ selection, share, logos, coinStatesById }: {
  selection: ReturnType<typeof useCompareSelection>;
  share: ReturnType<typeof useCompareShareActions>;
  logos: Record<string, string>;
  coinStatesById?: ReadonlyMap<string, readonly CoinState[]>;
}) {
  const { selectedIds, selectedCoins, coinOptions, disabledIds, handleSelect, handleRemove, setSelectedIds, applyPreset } = selection;
  const { toast, shareLoading, handleTwitterShare, handleWebShare, handleDownload } = share;
  const [linkCopied, setLinkCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const handleCopyLink = useCallback(async () => {
    const result = await copyText(window.location.href);
    if (!result.ok) return;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setLinkCopied(true);
    copyTimer.current = setTimeout(() => {
      setLinkCopied(false);
      copyTimer.current = null;
    }, 2500);
  }, []);

  const activeSelectionLabel = selectedCoins
    .filter((coin): coin is NonNullable<(typeof selectedCoins)[number]> => coin !== null)
    .map(stablecoinLabel)
    .join(" vs ");

  const selectionInsights = useMemo(
    () => buildCompareSelectionInsights({ selectedIds, coinStatesById }),
    [coinStatesById, selectedIds],
  );

  const portfolioHref = useMemo(() => {
    const coinsParam = selectedIds.map(encodeStablecoinUrlToken).join(",");
    const merged = mergeCoinsParam(null, coinsParam);
    return merged ? `/portfolio/?coins=${encodeURIComponent(coinsParam)}` : "/portfolio/";
  }, [selectedIds]);

  // Render selector slots (filled slots + empty slots up to MAX_COINS)
  const slots = [];
  for (let i = 0; i < MAX_COMPARE_COINS; i++) {
    const coin = selectedCoins[i] ?? null;
    slots.push(
      <CompareCoinSlot
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
      <CompareMobileSelectionControls
        selectedIds={selectedIds}
        selectedCoins={selectedCoins}
        coinOptions={coinOptions}
        coinStatesById={coinStatesById}
        logos={logos}
        disabledIds={disabledIds}
        onSelect={handleSelect}
        onRemove={handleRemove}
        onClear={() => setSelectedIds(() => [])}
      />

      <div className="hidden space-y-2 sm:block">
        <div className="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-5">{slots}</div>
        {selectedIds.length === 1 ? (
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Add one more stablecoin to open the side-by-side matrix, or click a pill to swap it.</span>
            <button
              type="button"
              onClick={() => setSelectedIds(() => [])}
              className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Clear all
            </button>
          </div>
        ) : null}
      </div>

      {selectedIds.length >= 2 ? (
        <div className="pharos-card-shell px-4 py-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="pharos-label">Active comparison</p>
                <p className="break-words text-sm font-medium text-foreground">
                  {activeSelectionLabel}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {toast ? (
                  <span role="status" aria-live="polite" className="mr-1 text-xs text-muted-foreground animate-fade-in">
                    {toast}
                  </span>
                ) : null}
                <Link
                  href={portfolioHref}
                  className={COMPARE_ACTION_BUTTON_CLASS}
                  title="Model these stablecoins in Portfolio"
                >
                  <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />
                  Model in Portfolio
                </Link>
                <CompareActionButton
                  icon={linkCopied ? Check : Link2}
                  label={linkCopied ? "Link copied" : "Copy link"}
                  title="Copy shareable comparison link"
                  ariaLabel={linkCopied ? "Comparison link copied" : "Copy comparison link"}
                  onClick={() => { void handleCopyLink(); }}
                />
                <CompareActionButton
                  icon={Share2}
                  label="Share image"
                  title="Share comparison card image"
                  ariaLabel="Share comparison image"
                  disabled={shareLoading}
                  onClick={handleWebShare}
                />
                <CompareActionButton
                  icon={Download}
                  label="Download PNG"
                  title="Download comparison PNG image"
                  ariaLabel="Download comparison as PNG image"
                  disabled={shareLoading}
                  onClick={handleDownload}
                />
                <CompareActionButton
                  icon={ExternalLink}
                  label="Post on X"
                  title="Share comparison on X (Twitter)"
                  ariaLabel="Share comparison on X"
                  disabled={shareLoading}
                  onClick={handleTwitterShare}
                />
                <button
                  type="button"
                  onClick={() => setSelectedIds(() => [])}
                  className="pharos-focus-ring pharos-control-pill hidden min-h-8 items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
                  aria-label="Clear all selected coins"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Clear all
                </button>
              </div>
            </div>
            {selectionInsights ? (
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="pharos-inset px-3.5 py-2.5">
                  <p className="pharos-label">How to read this set</p>
                  {selectionInsights.lens ? (
                    <p className="mt-1 text-sm text-foreground">{selectionInsights.lens}</p>
                  ) : null}
                  {selectionInsights.exceptional.length > 0 ? (
                    <ul aria-label="Members in an exceptional state" className="mt-2 space-y-1">
                      {selectionInsights.exceptional.map((member) => (
                        <li key={member.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <span className="font-semibold text-foreground">{stablecoinLabel(member)}</span>
                          <CoinStateChip state={member.state} showDetail />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {selectionInsights.cohort} {selectionInsights.structure}
                  </p>
                </div>
                <div className="pharos-inset px-3.5 py-2.5">
                  <p className="pharos-label">Jump to detail</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectionInsights.links.map((coin) => (
                      <Link
                        key={coin.id}
                        href={buildStablecoinUrl(coin.id)}
                        className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-foreground/20 hover:bg-accent lg:min-h-8"
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
