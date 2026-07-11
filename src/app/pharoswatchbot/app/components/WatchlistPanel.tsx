"use client";

import { useMemo, useRef, useState } from "react";
import { ExternalLink, Info, Search, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PHAROS_COIN_PAGE_PREFIX, SUGGESTED_SEARCH_IDS } from "../constants";
import type { TelegramWebAppSdk } from "../telegram-sdk";
import type {
  CatalogCoin,
  CoinInsightTarget,
  SubscribedCoin,
  TelegramMiniAppOperation,
  TelegramMiniAppState,
} from "../types";
import { MiniButton } from "./MiniButton";
import { CoinCard } from "./CoinCard";

function LaunchTargetCoinCard({ coinId, coin, canMutate, isMutating, pendingOperation, onMutate, onOpenInsight, webApp, highlighted }: {
  coinId: string;
  coin: CatalogCoin | null;
  canMutate: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  onOpenInsight: (target: CoinInsightTarget) => void;
  webApp: TelegramWebAppSdk | null;
  highlighted: boolean;
}) {
  const symbol = coin?.symbol ?? coinId;
  const name = coin?.name ?? "Launch target";
  const bridgeReady = Boolean(webApp);

  return (
    <article
      id={`coin-row-${coinId}`}
      className={cn(
        "rounded-2xl border bg-card/90 p-4 transition-colors",
        highlighted
          ? "mini-highlight"
          : "border-border/70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="pharos-kicker">Launch target</p>
          <h3 className="mt-1 truncate text-base font-semibold text-foreground">{symbol}</h3>
          <p className="truncate text-xs text-muted-foreground">{name}</p>
        </div>
        {coin ? (
          <MiniButton
            ariaLabel={`Follow ${coin.symbol}`}
            variant="secondary"
            disabled={!canMutate || isMutating}
            loading={pendingOperation?.kind === "set-coin" && pendingOperation.stablecoinId === coin.stablecoinId}
            onClick={() => onMutate({ kind: "set-coin", stablecoinId: coin.stablecoinId, patch: { alertTypes: { dews: true, depeg: true } } })}
          >
            Follow
          </MiniButton>
        ) : null}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {coin ? "Not in your explicit watchlist." : "This launch target is not in the current Mini App catalog. No settings were changed."}
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {coin ? (
          <>
            <MiniButton ariaLabel={`Why ${coin.symbol}`} variant="secondary" onClick={() => onOpenInsight({ kind: "why", coinId })}>
              <Info className="h-4 w-4" aria-hidden="true" /> Why
            </MiniButton>
            <MiniButton ariaLabel={`Coverage ${coin.symbol}`} variant="secondary" onClick={() => onOpenInsight({ kind: "coverage", coinId })}>
              <Info className="h-4 w-4" aria-hidden="true" /> Coverage
            </MiniButton>
          </>
        ) : null}
        <MiniButton
          ariaLabel={`View ${symbol} on Pharos`}
          variant="secondary"
          disabled={!bridgeReady}
          onClick={() => webApp?.openLink?.(`${PHAROS_COIN_PAGE_PREFIX}${coinId}`)}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" /> View on Pharos
        </MiniButton>
      </div>
    </article>
  );
}

export interface WatchlistPanelProps {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  /** Confirm-then-remove flow (lives in `useMiniAppMutations`). */
  onRemove: (coin: SubscribedCoin) => void;
  /** Open `CoinInsightPanel` for the target coin. */
  onOpenInsight: (target: CoinInsightTarget) => void;
  /** Undo toast subject. Non-null while the 5s grace window is active. */
  pendingUndo: SubscribedCoin | null;
  /** Restore the just-removed coin. */
  onUndo: () => void;
  /** Telegram bridge handle (used for `openLink`). */
  webApp: TelegramWebAppSdk | null;
  /** Current UNIX seconds; passed in to keep snooze comparison deterministic per render. */
  nowSec: number;
  /** Coin id with the temporary 2s sky highlight. */
  highlightedCoinId: string | null;
  /** Launch-target coin id when it's not yet in subscriptions. */
  targetCoinId: string | null;
  /** Focus and highlight an existing followed coin. */
  onNavigateToCoin: (coinId: string) => void;
}

export function WatchlistPanel({ state, canMutate, isMutating, pendingOperation, onMutate, onRemove, onOpenInsight, pendingUndo, onUndo, webApp, nowSec, highlightedCoinId, targetCoinId, onNavigateToCoin }: WatchlistPanelProps) {
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const subscribed = useMemo(() => new Set(state.subscriptions.map((coin) => coin.stablecoinId)), [state.subscriptions]);
  const catalogById = useMemo(
    () => new Map(state.catalog.searchableCoins.map((coin) => [coin.stablecoinId, coin])),
    [state.catalog.searchableCoins],
  );
  const targetCatalogCoin = targetCoinId && !subscribed.has(targetCoinId)
    ? catalogById.get(targetCoinId) ?? null
    : null;
  const shouldShowTargetCard = Boolean(targetCoinId && !subscribed.has(targetCoinId));
  const search = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return { results: [], total: 0 };
    const matches = state.catalog.searchableCoins
      .map((coin) => {
        const symbol = coin.symbol.toLowerCase();
        const name = coin.name.toLowerCase();
        const id = coin.stablecoinId.toLowerCase();
        const rank = symbol === q
          ? 0
          : symbol.startsWith(q) || name.startsWith(q) || id.startsWith(q)
            ? 1
            : symbol.includes(q) || name.includes(q) || id.includes(q)
              ? 2
              : null;
        return rank == null ? null : { coin, rank };
      })
      .filter((match): match is { coin: (typeof state.catalog.searchableCoins)[number]; rank: number } => match != null)
      .sort((a, b) => a.rank - b.rank || a.coin.symbol.localeCompare(b.coin.symbol));
    return { results: matches.slice(0, 8).map((match) => match.coin), total: matches.length };
  }, [query, state]);
  const { results, total: resultTotal } = search;
  const suggestions = useMemo(
    () =>
      SUGGESTED_SEARCH_IDS.map((id) => catalogById.get(id)).filter(
        (coin): coin is NonNullable<typeof coin> => Boolean(coin),
      ),
    [catalogById],
  );
  const queryLength = query.trim().length;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-[color:var(--mini-accent)]" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Add a coin</h2>
        </div>
        <label className="sr-only" htmlFor="telegram-mini-app-coin-search">Search stablecoins</label>
        <input
          ref={searchInputRef}
          id="telegram-mini-app-coin-search"
          className="pharos-focus-ring mt-3 h-11 w-full rounded-lg border border-border/65 bg-background/70 px-3 text-sm text-foreground placeholder:text-muted-foreground"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search symbol, name, or id"
        />
        {queryLength < 2 && suggestions.length > 0 ? (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {suggestions.map((coin) => {
              const following = subscribed.has(coin.stablecoinId);
              return (
                <button
                  key={coin.stablecoinId}
                  type="button"
                  aria-label={following ? `Go to followed ${coin.symbol}` : `Search for ${coin.symbol}`}
                  onClick={() => {
                    if (following) {
                      onNavigateToCoin(coin.stablecoinId);
                      return;
                    }
                    setQuery(coin.symbol);
                    queueMicrotask(() => searchInputRef.current?.focus());
                  }}
                  className={cn(
                    "pharos-focus-ring min-h-11 rounded-lg border px-2 py-2 text-center text-xs font-semibold transition-colors",
                    following
                      ? "mini-selected"
                      : "border-border/65 bg-background/55 text-foreground hover:bg-muted/40",
                  )}
                >
                  <span className="block">{coin.symbol}</span>
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    {following ? "Following" : coin.name}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        {queryLength >= 2 && results.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">No matches. Try a symbol like USDT or a name like Frax.</p>
        ) : null}
        {results.length > 0 ? (
          <>
            {resultTotal > results.length ? (
              <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
                Showing first {results.length} of {resultTotal}
              </p>
            ) : null}
            <div className="mt-3 grid gap-2" aria-live="polite">
              {results.map((coin) => {
                const following = subscribed.has(coin.stablecoinId);
                return (
                  <div key={coin.stablecoinId} className="flex items-center justify-between gap-3 rounded-xl border border-border/65 bg-background/55 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{coin.symbol}</p>
                      <p className="truncate text-xs text-muted-foreground">{coin.name}</p>
                    </div>
                    {following ? (
                      <span className="shrink-0 rounded-md border border-border/55 bg-muted/30 px-2 py-1 text-[11px] font-semibold text-muted-foreground">Following</span>
                    ) : (
                      <MiniButton
                        ariaLabel={`Follow ${coin.symbol}`}
                        variant="secondary"
                        disabled={!canMutate || isMutating}
                        onClick={() => onMutate({ kind: "set-coin", stablecoinId: coin.stablecoinId, patch: { alertTypes: { dews: true, depeg: true } } })}
                      >
                        Follow
                      </MiniButton>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </section>

      {pendingUndo ? (
        <section role="status" className="rounded-2xl border border-[color:var(--mini-accent-border)] bg-[color:var(--mini-accent-fill)] p-3 text-sm text-foreground">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate">{pendingUndo.symbol} removed from watchlist.</p>
            <MiniButton ariaLabel={`Undo remove ${pendingUndo.symbol}`} variant="secondary" disabled={!canMutate || isMutating} onClick={onUndo}>
              <Undo2 className="h-4 w-4" aria-hidden="true" /> Undo
            </MiniButton>
          </div>
        </section>
      ) : null}

      <div className="space-y-3">
        {shouldShowTargetCard && targetCoinId ? (
          <LaunchTargetCoinCard
            coinId={targetCoinId}
            coin={targetCatalogCoin}
            canMutate={canMutate}
            isMutating={isMutating}
            pendingOperation={pendingOperation}
            onMutate={onMutate}
            onOpenInsight={onOpenInsight}
            webApp={webApp}
            highlighted={highlightedCoinId === targetCoinId}
          />
        ) : null}
        {state.subscriptions.length > 0 ? state.subscriptions.map((coin) => (
          <CoinCard
            key={coin.stablecoinId}
            coin={coin}
            globalAlerts={state.subscriber.globalAlerts}
            presets={state.presets}
            canMutate={canMutate}
            isMutating={isMutating}
            pendingOperation={pendingOperation}
            onMutate={onMutate}
            onRemove={onRemove}
            onOpenInsight={onOpenInsight}
            webApp={webApp}
            nowSec={nowSec}
            highlighted={highlightedCoinId === coin.stablecoinId}
          />
        )) : (
          <section className="rounded-2xl border border-border/70 bg-card/90 p-4 text-sm text-muted-foreground">No explicit coin follows yet.</section>
        )}
      </div>
    </div>
  );
}
