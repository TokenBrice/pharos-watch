"use client";

import { ExternalLink, Info, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ALERT_LABELS,
  DEPEG_STEP_OPTIONS,
  DEWS_BAND_OPTIONS,
  PHAROS_COIN_PAGE_PREFIX,
  SAFETY_MODE_OPTIONS,
  SNOOZE_DURATION_TOKENS,
} from "../constants";
import { formatSnoozePill } from "../format";
import type { TelegramWebAppSdk } from "../telegram-sdk";
import type {
  CoinInsightTarget,
  SubscribedCoin,
  TelegramAlertType,
  TelegramCoinSnoozeDurationToken,
  TelegramMiniAppOperation,
} from "../types";
import { MiniButton } from "./MiniButton";
import { TogglePill } from "./TogglePill";

function SegmentedControl<T>({ value, options, onChange, disabled, ariaLabel }: {
  value: T;
  options: readonly { value: T; label: string; caption?: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "pharos-focus-ring min-h-12 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              selected ? "border-sky-500/35 bg-sky-500/10 text-sky-800 dark:text-sky-200" : "border-border/65 bg-background/60 text-muted-foreground hover:bg-muted/45",
            )}
          >
            <span className="block text-sm font-semibold">{option.label}</span>
            {option.caption ? <span className="block text-[11px] leading-tight">{option.caption}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface CoinCardProps {
  coin: SubscribedCoin;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  onRemove: (coin: SubscribedCoin) => void;
  onOpenInsight: (target: CoinInsightTarget) => void;
  webApp: TelegramWebAppSdk | null;
  /** Floor of current Date.now()/1000; passed in to keep snooze comparisons stable per render. */
  nowSec: number;
  /** True when this card matches `highlightedCoinId`. */
  highlighted: boolean;
}

export function CoinCard({ coin, canMutate, isMutating, onMutate, onRemove, onOpenInsight, webApp, nowSec, highlighted }: CoinCardProps) {
  const { dews: dewsEnabled, depeg: depegEnabled, safety: safetyEnabled } = coin.alertTypes;
  const showTune = dewsEnabled || depegEnabled || safetyEnabled;
  const coinSnoozeActive = coin.snoozeUntilTs != null && coin.snoozeUntilTs > nowSec;
  const handleOpenLink = (url: string) => {
    webApp?.openLink?.(url);
  };
  const bridgeReady = Boolean(webApp);
  const snoozeOperation = (token: TelegramCoinSnoozeDurationToken): TelegramMiniAppOperation => ({
    kind: "set-coin-snooze",
    stablecoinId: coin.stablecoinId,
    durationToken: token,
  });

  return (
    <article
      id={`coin-row-${coin.stablecoinId}`}
      className={cn(
        "rounded-2xl border bg-card/90 p-4 transition-colors",
        highlighted
          ? "border-sky-500/60 ring-2 ring-sky-500/35"
          : "border-border/70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-foreground">{coin.symbol}</h3>
          <p className="truncate text-xs text-muted-foreground">{coin.name}</p>
        </div>
        <MiniButton ariaLabel={`Remove ${coin.symbol}`} variant="secondary" disabled={!canMutate || isMutating} onClick={() => onRemove(coin)}>
          <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
        </MiniButton>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label={`${coin.symbol} alert types`}>
        {(Object.keys(ALERT_LABELS) as TelegramAlertType[]).map((type) => (
          <TogglePill
            key={type}
            label={ALERT_LABELS[type]}
            enabled={coin.alertTypes[type]}
            disabled={!canMutate || isMutating}
            ariaLabel={`${coin.symbol} ${ALERT_LABELS[type]}`}
            onToggle={() => onMutate({
              kind: "set-coin",
              stablecoinId: coin.stablecoinId,
              patch: { alertTypes: { [type]: !coin.alertTypes[type] } },
            })}
          />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label={`${coin.symbol} links`}>
        <MiniButton
          ariaLabel={`Why ${coin.symbol}`}
          variant="secondary"
          onClick={() => onOpenInsight({ kind: "why", coinId: coin.stablecoinId })}
        >
          <Info className="h-4 w-4" aria-hidden="true" /> Why
        </MiniButton>
        <MiniButton
          ariaLabel={`Coverage ${coin.symbol}`}
          variant="secondary"
          onClick={() => onOpenInsight({ kind: "coverage", coinId: coin.stablecoinId })}
        >
          <Info className="h-4 w-4" aria-hidden="true" /> Coverage
        </MiniButton>
        <MiniButton
          ariaLabel={`View ${coin.symbol} on Pharos`}
          variant="secondary"
          disabled={!bridgeReady}
          onClick={() => handleOpenLink(`${PHAROS_COIN_PAGE_PREFIX}${coin.stablecoinId}`)}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" /> View on Pharos
        </MiniButton>
      </div>
      <details className="mt-3 rounded-lg border border-border/55 bg-background/40 px-3 py-2">
        <summary className="cursor-pointer list-none text-xs font-semibold text-muted-foreground">
          Snooze {coin.symbol}
          {coinSnoozeActive && coin.snoozeUntilTs != null ? ` · until ${formatSnoozePill(coin.snoozeUntilTs)}` : ""}
        </summary>
        <div className="mt-3 space-y-2">
          {coinSnoozeActive ? (
            <MiniButton ariaLabel={`Clear ${coin.symbol} snooze`} variant="secondary" disabled={!canMutate || isMutating} onClick={() => onMutate(snoozeOperation("clear"))}>
              Clear snooze
            </MiniButton>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {SNOOZE_DURATION_TOKENS.map((token) => (
                <MiniButton
                  key={token}
                  ariaLabel={`Snooze ${coin.symbol} for ${token}`}
                  variant="secondary"
                  disabled={!canMutate || isMutating}
                  onClick={() => onMutate(snoozeOperation(token))}
                >
                  {token}
                </MiniButton>
              ))}
            </div>
          )}
        </div>
      </details>
      {showTune ? (
        <details className="mt-3 rounded-lg border border-border/55 bg-background/40 px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-muted-foreground">
            Tune {coin.symbol}
          </summary>
          <div className="mt-3 space-y-4">
            {dewsEnabled ? (
              <div>
                <p className="pharos-kicker">DEWS minimum band</p>
                <div className="mt-2">
                  <SegmentedControl
                    ariaLabel={`${coin.symbol} DEWS minimum band`}
                    value={coin.dewsMinBand}
                    options={[{ value: null, label: "Default", caption: "Any band" }, ...DEWS_BAND_OPTIONS]}
                    disabled={!canMutate || isMutating}
                    onChange={(next) => onMutate({ kind: "set-coin", stablecoinId: coin.stablecoinId, patch: { dewsMinBand: next } })}
                  />
                </div>
              </div>
            ) : null}
            {depegEnabled ? (
              <div>
                <p className="pharos-kicker">Depeg step</p>
                <div className="mt-2">
                  <SegmentedControl
                    ariaLabel={`${coin.symbol} depeg step`}
                    value={coin.depegStepBps}
                    options={DEPEG_STEP_OPTIONS}
                    disabled={!canMutate || isMutating}
                    onChange={(next) => onMutate({ kind: "set-coin", stablecoinId: coin.stablecoinId, patch: { depegStepBps: next } })}
                  />
                </div>
              </div>
            ) : null}
            {safetyEnabled ? (
              <div>
                <p className="pharos-kicker">Safety changes</p>
                <div className="mt-2">
                  <SegmentedControl
                    ariaLabel={`${coin.symbol} safety mode`}
                    value={coin.safetyMode}
                    options={[{ value: null, label: "Default" }, ...SAFETY_MODE_OPTIONS]}
                    disabled={!canMutate || isMutating}
                    onChange={(next) => onMutate({ kind: "set-coin", stablecoinId: coin.stablecoinId, patch: { safetyMode: next } })}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </article>
  );
}
