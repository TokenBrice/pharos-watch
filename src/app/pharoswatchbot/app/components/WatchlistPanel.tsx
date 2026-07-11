"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckSquare, ExternalLink, Info, Search, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PHAROS_COIN_PAGE_PREFIX, SUGGESTED_SEARCH_IDS } from "../constants";
import type { TelegramWebAppSdk } from "../telegram-sdk";
import type {
  CatalogCoin,
  CoinInsightTarget,
  SubscribedCoin,
  TelegramMiniAppOperation,
  TelegramMiniAppBulkWatchlistResponse,
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

type BulkPreview = Extract<TelegramMiniAppBulkWatchlistResponse["result"], { kind: "bulk-watchlist-preview" }>;
const BULK_UNDO_WINDOW_MS = 5_000;

function BulkWatchlistEditor({
  state,
  canMutate,
  canRead,
  writeDisabled,
  requestBusy,
  pendingOperation,
  onPreview,
  onConfirm,
  onUndo,
}: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  canRead: boolean;
  writeDisabled: boolean;
  requestBusy: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onPreview: (operation: Extract<TelegramMiniAppOperation, { kind: "preview-bulk-watchlist" }>) => Promise<TelegramMiniAppBulkWatchlistResponse | null>;
  onConfirm: (operation: Extract<TelegramMiniAppOperation, { kind: "confirm-bulk-watchlist" }>) => Promise<unknown>;
  onUndo: (operation: Extract<TelegramMiniAppOperation, { kind: "undo-bulk-watchlist" }>) => Promise<unknown>;
}) {
  const [query, setQuery] = useState("");
  const [addIds, setAddIds] = useState<string[]>([]);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [undo, setUndo] = useState<BulkPreview["undo"] | null>(null);
  const selectedCount = addIds.length + removeIds.length;
  const directIds = useMemo(() => new Set(state.subscriptions.map((coin) => coin.stablecoinId)), [state.subscriptions]);
  const matchingCatalog = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) return [];
    return state.catalog.searchableCoins
      .filter((coin) => !directIds.has(coin.stablecoinId))
      .filter((coin) => [coin.symbol, coin.name, coin.stablecoinId].some((value) => value.toLowerCase().includes(normalized)))
      .slice(0, 8);
  }, [directIds, query, state.catalog.searchableCoins]);

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), BULK_UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  const toggle = (stablecoinId: string, action: "add" | "remove") => {
    const setter = action === "add" ? setAddIds : setRemoveIds;
    setter((current) => {
      if (current.includes(stablecoinId)) return current.filter((id) => id !== stablecoinId);
      if (selectedCount >= 20) return current;
      return [...current, stablecoinId];
    });
    setPreview(null);
  };
  const label = (stablecoinId: string) => {
    const coin = state.catalog.searchableCoins.find((candidate) => candidate.stablecoinId === stablecoinId);
    return coin ? `${coin.symbol} (${coin.name})` : stablecoinId;
  };
  const previewChanges = async () => {
    const response = await onPreview({ kind: "preview-bulk-watchlist", addStablecoinIds: addIds, removeStablecoinIds: removeIds });
    if (response?.result.kind === "bulk-watchlist-preview") setPreview(response.result);
  };
  const confirm = async () => {
    if (!preview) return;
    const result = await onConfirm({
      kind: "confirm-bulk-watchlist",
      addStablecoinIds: addIds,
      removeStablecoinIds: removeIds,
      expectedPreferenceGeneration: preview.expectedPreferenceGeneration,
      previewFingerprint: preview.previewFingerprint,
    });
    if (result) {
      setUndo(preview.undo);
      setPreview(null);
      setAddIds([]);
      setRemoveIds([]);
      setQuery("");
    }
  };
  const undoChanges = async () => {
    if (!undo) return;
    const result = await onUndo({ kind: "undo-bulk-watchlist", ...undo });
    if (result) setUndo(null);
  };

  return (
    <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><CheckSquare className="h-4 w-4 text-[color:var(--mini-accent)]" aria-hidden="true" /><h2 className="text-sm font-semibold text-foreground">Bulk watchlist edit</h2></div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Select up to 20 direct rows. Presets and all-stablecoins settings stay unchanged.</p>
        </div>
        <span className="pharos-numeric shrink-0 rounded-md border border-border/60 bg-background/65 px-2 py-1 text-xs font-semibold text-muted-foreground">{selectedCount}/20</span>
      </div>
      <label htmlFor="mini-bulk-search" className="sr-only">Search coins to add in bulk</label>
      <input id="mini-bulk-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search coins to add" className="pharos-focus-ring mt-3 h-11 w-full rounded-lg border border-border/65 bg-background/70 px-3 text-sm text-foreground placeholder:text-muted-foreground" />
      {matchingCatalog.length > 0 ? <div className="mt-2 space-y-1" aria-label="Coins to add">
        {matchingCatalog.map((coin) => <label key={coin.stablecoinId} className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm text-foreground hover:bg-muted/35">
          <input type="checkbox" checked={addIds.includes(coin.stablecoinId)} disabled={requestBusy || (!addIds.includes(coin.stablecoinId) && selectedCount >= 20)} onChange={() => toggle(coin.stablecoinId, "add")} />
          <span className="min-w-0 truncate"><strong>{coin.symbol}</strong> <span className="text-muted-foreground">{coin.name}</span></span>
        </label>)}
      </div> : null}
      {state.subscriptions.length > 0 ? <fieldset className="mt-3 border-t border-border/55 pt-3"><legend className="text-xs font-semibold text-foreground">Remove direct rows</legend><div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
        {state.subscriptions.map((coin) => <label key={coin.stablecoinId} className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm text-foreground hover:bg-muted/35">
          <input type="checkbox" checked={removeIds.includes(coin.stablecoinId)} disabled={requestBusy || (!removeIds.includes(coin.stablecoinId) && selectedCount >= 20)} onChange={() => toggle(coin.stablecoinId, "remove")} />
          <span className="truncate">{coin.symbol} <span className="text-muted-foreground">{coin.name}</span></span>
        </label>)}
      </div></fieldset> : null}
      <div className="mt-3"><MiniButton variant="secondary" disabled={!canRead || requestBusy || selectedCount === 0} loading={pendingOperation?.kind === "preview-bulk-watchlist"} onClick={() => void previewChanges()}>Preview {selectedCount || ""} changes</MiniButton></div>
      {preview ? <div className="mt-3 border-t border-border/55 pt-3" aria-live="polite">
        <p className="text-sm font-semibold text-foreground">Review exact changes</p>
        <p className="mt-1 text-xs text-muted-foreground">Add: {preview.adds.map(label).join(", ") || "none"}</p>
        <p className="mt-1 text-xs text-muted-foreground">Remove: {preview.removes.map(label).join(", ") || "none"}</p>
        {preview.unchanged.length > 0 ? <p className="mt-1 text-xs text-muted-foreground">Already in this state: {preview.unchanged.map(label).join(", ")}</p> : null}
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{preview.sourceImpact.map((impact) => <li key={`${impact.action}-${impact.stablecoinId}`}>{label(impact.stablecoinId)}: direct row {impact.action === "add" ? "added" : "removed"}; inherited coverage after change: {impact.inheritedSourcesAfter.join(" + ") || "none"}.</li>)}</ul>
        <div className="mt-3"><MiniButton disabled={!canMutate || writeDisabled} loading={pendingOperation?.kind === "confirm-bulk-watchlist"} onClick={() => void confirm()}>Apply exact changes</MiniButton></div>
      </div> : null}
      {undo ? <div role="status" className="mt-3 flex items-center justify-between gap-3 border-t border-border/55 pt-3"><p className="text-xs text-muted-foreground">Bulk edit applied. Undo is available briefly.</p><MiniButton variant="secondary" disabled={!canMutate || writeDisabled} loading={pendingOperation?.kind === "undo-bulk-watchlist"} onClick={() => void undoChanges()}><Undo2 className="h-4 w-4" aria-hidden="true" /> Undo</MiniButton></div> : null}
    </section>
  );
}

export interface WatchlistPanelProps {
  state: TelegramMiniAppState;
  canMutate: boolean;
  canReadBulk: boolean;
  isMutating: boolean;
  isRequestBusy: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  onPreviewBulk: (operation: Extract<TelegramMiniAppOperation, { kind: "preview-bulk-watchlist" }>) => Promise<TelegramMiniAppBulkWatchlistResponse | null>;
  onConfirmBulk: (operation: Extract<TelegramMiniAppOperation, { kind: "confirm-bulk-watchlist" }>) => Promise<unknown>;
  onUndoBulk: (operation: Extract<TelegramMiniAppOperation, { kind: "undo-bulk-watchlist" }>) => Promise<unknown>;
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

export function WatchlistPanel({ state, canMutate, canReadBulk, isMutating, isRequestBusy, pendingOperation, onMutate, onPreviewBulk, onConfirmBulk, onUndoBulk, onRemove, onOpenInsight, pendingUndo, onUndo, webApp, nowSec, highlightedCoinId, targetCoinId, onNavigateToCoin }: WatchlistPanelProps) {
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

      <BulkWatchlistEditor
        state={state}
        canMutate={canMutate}
        canRead={canReadBulk}
        writeDisabled={isMutating}
        requestBusy={isRequestBusy}
        pendingOperation={pendingOperation}
        onPreview={onPreviewBulk}
        onConfirm={onConfirmBulk}
        onUndo={onUndoBulk}
      />

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
