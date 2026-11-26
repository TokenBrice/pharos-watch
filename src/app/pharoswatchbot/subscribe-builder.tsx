"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Briefcase, Check, Copy, ExternalLink, Send, Star, X } from "lucide-react";
import { CoinSelector } from "@/components/coin-selector";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/hooks/use-hydrated";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useWatchlist } from "@/hooks/use-watchlist";
import { copyText } from "@/lib/clipboard";
import type { CoinOption } from "@/lib/compare-types";
import { logosById } from "@/lib/logos";
import { PHAROSWATCHBOT_BOT_URL, SETUP_DEEP_LINK } from "@/lib/telegram-route-constants";
import { cn } from "@/lib/utils";
import {
  CLIENT_ACTIVE_STABLECOINS,
  CLIENT_TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/client-registry";
import {
  TELEGRAM_ALERT_FAMILIES,
  TELEGRAM_PRESET_ALERT_TYPES,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { isTelegramReservedTargetToken } from "@shared/lib/telegram-command-vocabulary";
import { formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import type { TelegramLiveAlertType } from "@shared/types/status";
import { BotSection } from "./bot-section";

const ACTIVE_COIN_OPTIONS: CoinOption[] = CLIENT_ACTIVE_STABLECOINS.map((coin) => ({
  id: coin.id,
  name: coin.name,
  symbol: coin.symbol,
}));

const ACTIVE_COIN_BY_ID = new Map(ACTIVE_COIN_OPTIONS.map((coin) => [coin.id, coin]));

const SYMBOL_COUNT = new Map<string, number>();
for (const coin of CLIENT_TRACKED_STABLECOINS) {
  const key = coin.symbol.toLowerCase();
  SYMBOL_COUNT.set(key, (SYMBOL_COUNT.get(key) ?? 0) + 1);
}

const UNIQUE_ACTIVE_ID_BY_SYMBOL = new Map<string, string>();
for (const coin of ACTIVE_COIN_OPTIONS) {
  const key = coin.symbol.toLowerCase();
  if ((SYMBOL_COUNT.get(key) ?? 0) === 1) {
    UNIQUE_ACTIVE_ID_BY_SYMBOL.set(key, coin.id);
  }
}

const POPULAR_COIN_IDS = [
  "usdc-circle",
  "usdt-tether",
  "usds-sky",
  "usde-ethena",
  "dai-makerdao",
] as const;

const POPULAR_COINS = POPULAR_COIN_IDS.map((id) => ACTIVE_COIN_BY_ID.get(id)).filter(
  (coin): coin is CoinOption => coin != null,
);

const DEFAULT_FAMILIES: readonly TelegramLiveAlertType[] = ["dews", "depeg", "safety"];
const PRESET_SUPPORTED_FAMILIES = new Set<TelegramLiveAlertType>(TELEGRAM_PRESET_ALERT_TYPES);
const TELEGRAM_TARGET_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_BUILDER_COINS = 12;

function reconcileFamiliesForPreset(families: readonly TelegramLiveAlertType[]): TelegramLiveAlertType[] {
  const supported = families.filter((family) => PRESET_SUPPORTED_FAMILIES.has(family));
  return supported.length > 0 ? supported : [...DEFAULT_FAMILIES];
}

function resolveCoinToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (ACTIVE_COIN_BY_ID.has(trimmed)) return trimmed;
  return UNIQUE_ACTIVE_ID_BY_SYMBOL.get(trimmed.toLowerCase()) ?? null;
}

function parseUrlCoinIds(params: URLSearchParams): string[] {
  const rawTokens = [...params.getAll("coin"), ...params.getAll("coins")]
    .flatMap((value) => value.split(","));
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const token of rawTokens) {
    const id = resolveCoinToken(token);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    resolved.push(id);
    if (resolved.length >= MAX_BUILDER_COINS) break;
  }
  return resolved;
}

function commandTargetToken(coin: CoinOption): string {
  const count = SYMBOL_COUNT.get(coin.symbol.toLowerCase()) ?? 0;
  return count === 1
    && TELEGRAM_TARGET_TOKEN_PATTERN.test(coin.symbol)
    && !isTelegramReservedTargetToken(coin.symbol)
    ? coin.symbol
    : coin.id;
}

/**
 * Client-side subscribe command builder supporting `?coin=` / `?coins=` deep
 * links, saved Watchlist import, Portfolio holdings import, and Private vs
 * Group command syntax.
 */
export function SubscribeCommandBuilder() {
  const hydrated = useHydrated();
  const { searchParams } = useUrlFilters();
  const urlCoinIds = useMemo(() => parseUrlCoinIds(searchParams), [searchParams]);
  const [editedCoinIds, setEditedCoinIds] = useState<string[] | null>(null);
  const [selectedFamilies, setSelectedFamilies] = useState<TelegramLiveAlertType[]>([...DEFAULT_FAMILIES]);
  const [chatScope, setChatScope] = useState<"private" | "group">("private");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { ids: watchlistIds } = useWatchlist();
  const { holdings } = usePortfolio(null, hydrated, { ignoreUrl: true });

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const activeWatchlistIds = useMemo(
    () => watchlistIds.filter((id) => ACTIVE_COIN_BY_ID.has(id)).slice(0, MAX_BUILDER_COINS),
    [watchlistIds],
  );
  const activePortfolioIds = useMemo(
    () => (hydrated
      ? holdings.map((holding) => holding.coinId).filter((id) => ACTIVE_COIN_BY_ID.has(id)).slice(0, MAX_BUILDER_COINS)
      : []),
    [hydrated, holdings],
  );

  const selectedIds = editedCoinIds ?? urlCoinIds;
  const selectedCoins = useMemo(
    () => selectedIds.map((id) => ACTIVE_COIN_BY_ID.get(id)).filter((coin): coin is CoinOption => coin != null),
    [selectedIds],
  );
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const isPresetTarget = selectedCoins.length === 0;

  const addCoin = useCallback((coin: CoinOption) => {
    if (selectedIds.length === 0) {
      setSelectedFamilies((prev) => reconcileFamiliesForPreset(prev));
    }
    setEditedCoinIds((prev) => {
      const base = prev ?? urlCoinIds;
      if (base.includes(coin.id) || base.length >= MAX_BUILDER_COINS) return base;
      return [...base, coin.id];
    });
  }, [selectedIds.length, urlCoinIds]);

  const removeCoin = useCallback((coinId: string) => {
    const next = selectedIds.filter((id) => id !== coinId);
    setEditedCoinIds(next);
    if (next.length === 0) {
      setSelectedFamilies((prev) => reconcileFamiliesForPreset(prev));
    }
  }, [selectedIds]);

  const clearSelection = useCallback(() => {
    setEditedCoinIds([]);
    setSelectedFamilies((prev) => reconcileFamiliesForPreset(prev));
  }, []);

  const toggleFamily = useCallback((family: TelegramLiveAlertType) => {
    if (isPresetTarget && !PRESET_SUPPORTED_FAMILIES.has(family)) return;
    setSelectedFamilies((prev) => {
      const base = isPresetTarget ? reconcileFamiliesForPreset(prev) : prev;
      if (base.includes(family)) {
        return base.length > 1 ? base.filter((item) => item !== family) : base;
      }
      return [...base, family];
    });
  }, [isPresetTarget]);

  const effectiveFamilies = useMemo(
    () => (isPresetTarget ? reconcileFamiliesForPreset(selectedFamilies) : selectedFamilies),
    [isPresetTarget, selectedFamilies],
  );

  const orderedFamilies = useMemo(
    () => TELEGRAM_ALERT_FAMILIES.map((family) => family.key).filter((key) => effectiveFamilies.includes(key)),
    [effectiveFamilies],
  );

  const commandPrefix = chatScope === "group" ? `/subscribe@${TELEGRAM_BOT_USERNAME}` : "/subscribe";
  const targetsString = selectedCoins.length > 0
    ? selectedCoins.map(commandTargetToken).join(" ")
    : "usd-top25";
  const subscribeCommand = `${commandPrefix} ${orderedFamilies.join(",")} ${targetsString}`;

  const singleCoinDeepLink = chatScope === "private" && selectedCoins.length === 1
    ? `${PHAROSWATCHBOT_BOT_URL}?startapp=${formatCoinPayload(selectedCoins[0]!.id)}`
    : null;

  const handleCopy = useCallback(async () => {
    const result = await copyText(subscribeCommand);
    if (!result.ok) return;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopied(true);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      copyTimer.current = null;
    }, 2200);
  }, [subscribeCommand]);

  return (
    <BotSection
      id="builder"
      kicker="Group & batch setup"
      title="Build a subscribe command"
      lead="For Telegram groups, or moving a Watchlist or Portfolio into chat at once. Pick coins below and paste one command into your group or @PharosWatchBot."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {activeWatchlistIds.length > 0 ? (
            <button
              type="button"
              onClick={() => setEditedCoinIds(activeWatchlistIds)}
              className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground sm:min-h-8"
            >
              <Star className="h-3.5 w-3.5 text-brand-accent-text" aria-hidden="true" />
              Import my Watchlist ({activeWatchlistIds.length})
            </button>
          ) : null}
          {activePortfolioIds.length > 0 ? (
            <button
              type="button"
              onClick={() => setEditedCoinIds(activePortfolioIds)}
              className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground sm:min-h-8"
            >
              <Briefcase className="h-3.5 w-3.5 text-brand-accent-text" aria-hidden="true" />
              Import my Portfolio ({activePortfolioIds.length})
            </button>
          ) : null}
          {POPULAR_COINS.map((coin) => {
            const active = selectedIdSet.has(coin.id);
            return (
              <button
                key={coin.id}
                type="button"
                aria-pressed={active}
                onClick={() => (active ? removeCoin(coin.id) : addCoin(coin))}
                className={cn(
                  "pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-2.5 py-1 text-xs font-medium sm:min-h-8",
                  active && "pharos-control-pill-active",
                )}
              >
                <StablecoinLogo src={logosById[coin.id]} name={coin.name} size={16} />
                <span>{coin.symbol}</span>
              </button>
            );
          })}
          {selectedCoins.length > 0 ? (
            <button
              type="button"
              onClick={clearSelection}
              className="pharos-focus-ring ml-auto rounded-sm px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear selection
            </button>
          ) : null}
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] lg:items-start">
          <div>
            <p id="builder-coin-picker-label" className="pharos-label mb-1.5">
              Add stablecoins ({selectedCoins.length}/{MAX_BUILDER_COINS})
            </p>
            <div role="group" aria-labelledby="builder-coin-picker-label">
              <CoinSelector
                coins={ACTIVE_COIN_OPTIONS}
                selected={null}
                logos={logosById}
                disabledIds={selectedIdSet}
                disabled={selectedCoins.length >= MAX_BUILDER_COINS}
                onSelect={addCoin}
                onRemove={() => {}}
              />
            </div>
          </div>

          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div role="group" aria-label="Alert families for command" className="flex flex-wrap items-center gap-1.5">
                {TELEGRAM_ALERT_FAMILIES.map((family) => {
                  const disabled = isPresetTarget && !PRESET_SUPPORTED_FAMILIES.has(family.key);
                  const active = !disabled && effectiveFamilies.includes(family.key);
                  return (
                    <button
                      key={family.key}
                      type="button"
                      disabled={disabled}
                      aria-pressed={active}
                      onClick={() => toggleFamily(family.key)}
                      className={cn(
                        "pharos-focus-ring pharos-control-pill min-h-9 px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-7",
                        active && "pharos-control-pill-active",
                      )}
                    >
                      {family.shortLabel}
                    </button>
                  );
                })}
              </div>
              <div role="group" aria-label="Chat type for command" className="pharos-segmented">
                {(["private", "group"] as const).map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    aria-pressed={chatScope === scope}
                    onClick={() => setChatScope(scope)}
                    className="pharos-focus-ring pharos-segmented-item min-h-9 px-3 text-xs sm:min-h-7"
                  >
                    {scope === "private" ? "Private" : "Group"}
                  </button>
                ))}
              </div>
            </div>

            {selectedCoins.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Selected stablecoins for command">
                {selectedCoins.map((coin) => (
                  <li
                    key={coin.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/35 py-1 pl-2 pr-1 text-xs text-foreground"
                  >
                    <StablecoinLogo src={logosById[coin.id]} name={coin.name} size={16} />
                    <span className="font-medium">{coin.symbol}</span>
                    <button
                      type="button"
                      onClick={() => removeCoin(coin.id)}
                      aria-label={`Remove ${coin.name} from command`}
                      className="pharos-focus-ring inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>
                  No specific coins selected yet; defaulting to the <code className="font-mono text-foreground">usd-top25</code> preset.
                </p>
                <p>Pick specific coins above to add Reserve drift or Freeze alerts.</p>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 sm:flex-row sm:items-center">
            <code
              data-testid="telegram-subscribe-command"
              className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs font-semibold text-foreground sm:text-sm"
            >
              {subscribeCommand}
            </code>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { void handleCopy(); }}
                aria-label={copied ? "Copied subscribe command" : "Copy subscribe command"}
                className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 bg-background px-3 py-1.5 text-xs font-medium text-foreground sm:min-h-8"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-state-positive" aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    Copy command
                  </>
                )}
              </button>
              {chatScope === "group" ? null : singleCoinDeepLink ? (
                <Button asChild size="sm" variant="outline" className="gap-1.5">
                  <a href={singleCoinDeepLink} target="_blank" rel="noopener noreferrer">
                    Open {selectedCoins[0]!.symbol} in Mini App
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </Button>
              ) : (
                <Button asChild size="sm" variant="outline" className="gap-1.5">
                  <a href={SETUP_DEEP_LINK} target="_blank" rel="noopener noreferrer">
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    Open @PharosWatchBot
                  </a>
                </Button>
              )}
            </div>
          </div>
          {chatScope === "group" ? (
            <p className="text-xs text-muted-foreground">
              Paste in your group chat after adding @{TELEGRAM_BOT_USERNAME}.
            </p>
          ) : null}
        </div>
      </div>
    </BotSection>
  );
}
