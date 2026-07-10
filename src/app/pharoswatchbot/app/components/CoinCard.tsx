"use client";

import { ExternalLink, Info, ShieldCheck, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ALERT_LABELS,
  DEPEG_STEP_OPTIONS,
  DEWS_BAND_OPTIONS,
  PHAROS_COIN_PAGE_PREFIX,
  SAFETY_MODE_OPTIONS,
  SNOOZE_DURATION_TOKENS,
} from "../constants";
import { computeEffectiveSource, formatSnoozePill } from "../format";
import type { TelegramWebAppSdk } from "../telegram-sdk";
import type {
  CoinInsightTarget,
  FollowedPreset,
  SubscribedCoin,
  TelegramAlertType,
  TelegramCoinSnoozeDurationToken,
  TelegramMiniAppOperation,
  TelegramMiniAppState,
} from "../types";
import { MiniButton } from "./MiniButton";
import { SegmentedControl } from "./SegmentedControl";
import { TogglePill } from "./TogglePill";

type SourceChip = { label: string; className: string };

// C74: collapse the per-type effective-source map into the single dominant lane
// the chip should advertise. Precedence for the displayed lane mirrors the model:
// an enabled per-coin flag wins; otherwise a marked local-off row is a muted override;
// otherwise the coin rides the inherited default lane.
function deriveSourceChip(
  coin: SubscribedCoin,
  globalAlerts: TelegramMiniAppState["subscriber"]["globalAlerts"],
  presets: readonly FollowedPreset[],
): SourceChip {
  const sources = Object.values(computeEffectiveSource(coin, globalAlerts, presets));
  if (sources.includes("per-coin")) {
    return { label: "Per-coin", className: "border-primary/40 bg-primary/10 text-primary" };
  }
  if (sources.includes("off-override")) {
    return { label: "Muted override", className: "border-border/60 bg-muted/40 text-muted-foreground" };
  }
  return { label: "All-stablecoins", className: "border-border/60 bg-muted/40 text-muted-foreground" };
}

export interface CoinCardProps {
  coin: SubscribedCoin;
  /** Subscriber global-default flags; used to classify the effective alert source (C74). */
  globalAlerts: TelegramMiniAppState["subscriber"]["globalAlerts"];
  /** Followed presets; used to classify the effective alert source (C74). */
  presets: readonly FollowedPreset[];
  canMutate: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  onRemove: (coin: SubscribedCoin) => void;
  onOpenInsight: (target: CoinInsightTarget) => void;
  webApp: TelegramWebAppSdk | null;
  /** Floor of current Date.now()/1000; passed in to keep snooze comparisons stable per render. */
  nowSec: number;
  /** True when this card matches `highlightedCoinId`. */
  highlighted: boolean;
}

export function CoinCard({ coin, globalAlerts, presets, canMutate, isMutating, pendingOperation, onMutate, onRemove, onOpenInsight, webApp, nowSec, highlighted }: CoinCardProps) {
  const sourceChip = deriveSourceChip(coin, globalAlerts, presets);
  const { dews: dewsEnabled, depeg: depegEnabled, safety: safetyEnabled } = coin.alertTypes;
  const showTune = dewsEnabled || depegEnabled || safetyEnabled || coin.depegStepBps != null;
  const untunableLabels = [
    coin.alertTypes.launch ? "Launch" : null,
    coin.alertTypes.reserve ? "Reserve" : null,
  ].filter((label): label is string => label != null);
  const untunableOnly = untunableLabels.length > 0 && !showTune;
  const coinSnoozeActive = coin.snoozeUntilTs != null && coin.snoozeUntilTs > nowSec;
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
          ? "mini-highlight"
          : "border-border/70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 max-w-full truncate text-base font-semibold text-foreground">{coin.symbol}</h3>
            <span
              className={cn(
                "max-w-full shrink truncate rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                sourceChip.className,
              )}
            >
              {sourceChip.label}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{coin.name}</p>
        </div>
        <MiniButton ariaLabel={`Remove ${coin.symbol}`} variant="secondary" disabled={!canMutate || isMutating} onClick={() => onRemove(coin)}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </MiniButton>
      </div>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`${coin.symbol} alert types`}>
        {(Object.keys(ALERT_LABELS) as TelegramAlertType[]).map((type) => (
          <TogglePill
            key={type}
            label={ALERT_LABELS[type]}
            enabled={coin.alertTypes[type]}
            disabled={!canMutate || isMutating}
            loading={
              pendingOperation?.kind === "set-coin" &&
              pendingOperation.stablecoinId === coin.stablecoinId &&
              pendingOperation.patch.alertTypes?.[type] != null
            }
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
          <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Coverage
        </MiniButton>
        <MiniButton
          ariaLabel={`View ${coin.symbol} on Pharos`}
          variant="secondary"
          disabled={!bridgeReady}
          onClick={() => webApp?.openLink?.(`${PHAROS_COIN_PAGE_PREFIX}${coin.stablecoinId}`)}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" /> View on Pharos
        </MiniButton>
      </div>
      <details className="mt-3 rounded-lg border border-border/55 bg-background/40 px-3">
        <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center rounded-md text-xs font-semibold text-muted-foreground">
          Snooze {coin.symbol}
          {coinSnoozeActive && coin.snoozeUntilTs != null ? ` · until ${formatSnoozePill(coin.snoozeUntilTs)}` : ""}
        </summary>
        <div className="mt-3 space-y-2 pb-3">
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
                  loading={
                    pendingOperation?.kind === "set-coin-snooze" &&
                    pendingOperation.stablecoinId === coin.stablecoinId &&
                    pendingOperation.durationToken === token
                  }
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
        <details className="mt-3 rounded-lg border border-border/55 bg-background/40 px-3">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center rounded-md text-xs font-semibold text-muted-foreground">
            Tune {coin.symbol}
          </summary>
          <div className="mt-3 space-y-4 pb-3">
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
            {depegEnabled || coin.depegStepBps != null ? (
              <div>
                <p className="pharos-kicker">Depeg step</p>
                {!depegEnabled ? (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Setting a step also enables depeg alerts.
                  </p>
                ) : null}
                <div className="mt-2">
                  <SegmentedControl
                    ariaLabel={`${coin.symbol} depeg step`}
                    value={coin.depegStepBps}
                    options={DEPEG_STEP_OPTIONS}
                    disabled={!canMutate || isMutating}
                    onChange={(next) => onMutate({
                      kind: "set-coin",
                      stablecoinId: coin.stablecoinId,
                      patch: next != null && !depegEnabled
                        ? { depegStepBps: next, alertTypes: { depeg: true } }
                        : { depegStepBps: next },
                    })}
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
      ) : untunableOnly ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {untunableLabels.join(" & ")}: on/off only. No tuning.
        </p>
      ) : null}
    </article>
  );
}
