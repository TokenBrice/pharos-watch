"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { BULK_SELECTION_LIMIT, LIVE_ALERT_TYPES, presetLabel } from "../constants";
import { ALL_STABLECOINS_LABEL, displayCoinName, hasOwnEnabledFamily } from "../format";
import { usePrimaryAction } from "../primary-action";
import { canUseTelegramPopup, type TelegramWebAppSdk } from "../telegram-sdk";
import type { CatalogCoin, MiniAppScreenProps } from "../types";
import { ListRow, ListSection, useMiniAppHaptics } from "./List";

const RESULT_LIMIT = 40;
const SUGGESTION_LIMIT = 15;
const CHANGE_COUNTER_THRESHOLD = 15;

/** Exact symbol, then prefix, then substring/peg; ties keep market-cap order. */
export function searchCatalog(coins: readonly CatalogCoin[], query: string): CatalogCoin[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return coins
    .map((coin) => {
      const symbol = coin.symbol.toLowerCase();
      const name = coin.name.toLowerCase();
      const peg = coin.peg?.toLowerCase() ?? "";
      const pegLabel = coin.pegLabel?.toLowerCase() ?? "";
      const bucket = symbol === q ? 0
        : symbol.startsWith(q) ? 1
          : name.startsWith(q) ? 2
            : symbol.includes(q)
              || name.includes(q)
              || coin.stablecoinId.toLowerCase().includes(q)
              || peg === q
              || peg.startsWith(q)
              || pegLabel.includes(q)
              ? 3
              : null;
      return bucket == null ? null : { coin, bucket };
    })
    .filter((match): match is { coin: CatalogCoin; bucket: number } => match != null)
    .sort((left, right) => left.bucket - right.bucket
      || (left.coin.rank ?? Number.MAX_SAFE_INTEGER) - (right.coin.rank ?? Number.MAX_SAFE_INTEGER))
    .map((match) => match.coin);
}

/** The default list: the largest unfollowed base stablecoins, filtering out wrapper variants (`variantOf`) while keeping standalone yield-bearing stablecoins visible. */
export function largestBaseCoins(ranked: readonly CatalogCoin[], followedIds: ReadonlySet<string>): CatalogCoin[] {
  return ranked.filter((coin) => !coin.variant && !followedIds.has(coin.stablecoinId)).slice(0, SUGGESTION_LIMIT);
}

function countLabel(added: number, removed: number): string {
  const coins = (count: number) => `${count} ${count === 1 ? "coin" : "coins"}`;
  if (removed === 0) return `Add ${coins(added)}`;
  if (added === 0) return `Remove ${coins(removed)}`;
  return `Save ${added + removed} changes`;
}

export interface AddCoinsScreenProps extends MiniAppScreenProps {
  onApply: (addStablecoinIds: string[], removeStablecoinIds: string[]) => Promise<boolean>;
  onDone: () => void;
  webApp?: TelegramWebAppSdk | null;
  hasInlineBack?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  registerBackGuard?: (guard: ((onProceed: () => void) => boolean) | null) => void;
}

/** One multi-select over the catalog: tick to add, untick a followed coin to remove. */
export function AddCoinsScreen({
  state,
  canEdit,
  busy,
  pendingOperation,
  onApply,
  onDone,
  webApp = null,
  hasInlineBack = false,
  onDirtyChange,
  registerBackGuard,
}: AddCoinsScreenProps) {
  const haptics = useMiniAppHaptics();
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const [query, setQuery] = useState("");
  const [adds, setAdds] = useState<string[]>([]);
  const [removes, setRemoves] = useState<string[]>([]);
  const [previousSubscriptions, setPreviousSubscriptions] = useState(state.subscriptions);
  // Only rows with an own enabled family count as directly followed here; snooze-only
  // and override-only rows are never pre-checked or silently removed via bulk edit.
  const followedIds = useMemo(
    () => new Set(state.subscriptions.filter(hasOwnEnabledFamily).map((coin) => coin.stablecoinId)),
    [state.subscriptions],
  );
  // Undo or a refresh can satisfy part of the draft before it is submitted.
  if (previousSubscriptions !== state.subscriptions) {
    setPreviousSubscriptions(state.subscriptions);
    setAdds((current) => current.filter((id) => !followedIds.has(id)));
    setRemoves((current) => current.filter((id) => followedIds.has(id)));
  }
  const ranked = useMemo(
    () => [...state.catalog.searchableCoins].sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)),
    [state.catalog.searchableCoins],
  );
  const coinById = useMemo(
    () => new Map(ranked.map((coin) => [coin.stablecoinId, coin])),
    [ranked],
  );
  const hasAnyGlobal = LIVE_ALERT_TYPES.some((type) => state.subscriber.globalAlerts[type]);
  const hasUnreadablePreset = state.presets.some((preset) => preset.memberIds == null);
  const presetMembers = useMemo(() => {
    const members = new Map<string, string>();
    for (const preset of state.presets) {
      for (const id of preset.memberIds ?? []) {
        if (!members.has(id)) members.set(id, presetLabel(preset.id, preset.label));
      }
    }
    return members;
  }, [state.presets]);
  const matches = useMemo(() => searchCatalog(ranked, query), [query, ranked]);
  const changeCount = adds.length + removes.length;
  const atLimit = changeCount >= BULK_SELECTION_LIMIT;
  const applying = pendingOperation?.kind === "apply-bulk-watchlist"
    || pendingOperation?.kind === "preview-bulk-watchlist"
    || pendingOperation?.kind === "confirm-bulk-watchlist";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    onDirtyChange?.(changeCount > 0);
    return () => onDirtyChange?.(false);
  }, [changeCount, onDirtyChange]);

  useEffect(() => {
    if (!registerBackGuard) return undefined;
    if (changeCount === 0 || applying) {
      registerBackGuard(null);
      return () => registerBackGuard(null);
    }
    const label = `${changeCount} ${changeCount === 1 ? "change" : "changes"}`;
    registerBackGuard((onProceed) => {
      if (canUseTelegramPopup(webApp)) {
        webApp!.showPopup!(
          {
            title: `Discard ${label}?`,
            message: "Your selections won't be saved.",
            buttons: [
              { id: "discard", type: "destructive", text: "Discard" },
              { id: "keep", type: "cancel", text: "Keep editing" },
            ],
          },
          (buttonId) => {
            if (buttonId === "discard") onProceed();
          },
        );
        return false;
      }
      if (webApp?.showConfirm) {
        webApp.showConfirm(`Discard ${label}?`, (confirmed) => {
          if (confirmed) onProceed();
        });
        return false;
      }
      return true;
    });
    return () => registerBackGuard(null);
  }, [applying, changeCount, registerBackGuard, webApp]);

  usePrimaryAction(canEdit && changeCount > 0 ? {
    kind: "apply-bulk",
    text: countLabel(adds.length, removes.length),
    progress: applying,
    onClick: () => {
      if (busy) return;
      void onApply(adds, removes).then((saved) => {
        if (saved && mountedRef.current) onDone();
      });
    },
  } : null);

  const isSelected = (id: string) => (followedIds.has(id) ? !removes.includes(id) : adds.includes(id));
  const toggle = (id: string) => {
    haptics?.selectionChanged?.();
    const followed = followedIds.has(id);
    const setter = followed ? setRemoves : setAdds;
    setter((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      return atLimit ? current : [...current, id];
    });
  };

  const renderRow = (coin: Pick<CatalogCoin, "stablecoinId" | "symbol" | "name" | "pegLabel"> & { peg?: string | null }) => {
    const id = coin.stablecoinId;
    const following = followedIds.has(id);
    const selected = isSelected(id);
    const adding = !following && adds.includes(id);
    const removing = following && removes.includes(id);
    const changed = adding || removing;
    const preset = presetMembers.get(id);
    const coverAfterRemove = preset ?? (hasAnyGlobal ? ALL_STABLECOINS_LABEL : undefined);
    const status = following ? (removing ? "Will be removed" : "Following") : adding ? "Will be added" : null;
    const secondaryName = displayCoinName(coin.symbol, coin.name);
    const metaParts = [
      coin.pegLabel ?? (coin.peg ? `${coin.peg} peg` : null),
      !following && preset ? `In ${preset}` : null,
      removing && coverAfterRemove ? `Still covered by ${coverAfterRemove}` : null,
    ].filter(Boolean);
    const subtitleText = [status, ...metaParts].filter(Boolean).join(" · ") || undefined;
    return (
      <ListRow
        key={id}
        ariaChecked={selected}
        ariaLabel={`${coin.symbol}${secondaryName ? ` ${secondaryName}` : ""}${status ? `, ${status.toLowerCase()}` : ""}`}
        disabled={!canEdit || busy || (!changed && atLimit)}
        className="min-h-[3.25rem] before:left-[3.25rem]"
        leading={(
          <span
            aria-hidden="true"
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors",
              // 4 distinct visual states: untouched, already following, adding, removing.
              adding && "border-transparent bg-[var(--telegram-button,var(--mini-accent))] text-[color:var(--telegram-button-text,white)]",
              selected && following && "border-transparent bg-[var(--mini-accent-fill)] text-[color:var(--mini-accent)]",
              removing && "border-[color:var(--telegram-destructive-text,var(--state-danger-text))]",
              !selected && !removing && "border-[color:var(--border)]",
            )}
          >
            {selected ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
          </span>
        )}
        title={(
          <>
            <span className="font-medium">{coin.symbol}</span>
            {secondaryName ? <> <span className="text-muted-foreground">{secondaryName}</span></> : null}
          </>
        )}
        subtitle={removing ? (
          <>
            <span className="text-[color:var(--telegram-destructive-text,var(--state-danger-text))]">Will be removed</span>
            {metaParts.length > 0 ? ` · ${metaParts.join(" · ")}` : null}
          </>
        ) : subtitleText}
        onClick={() => toggle(id)}
      />
    );
  };

  const hasQuery = query.trim().length > 0;
  const selectedCoins = useMemo(
    () => (hasQuery
      ? []
      : [...adds, ...removes]
        .map((id) => coinById.get(id))
        .filter((coin): coin is CatalogCoin => coin != null)),
    [adds, coinById, hasQuery, removes],
  );
  const followed = useMemo(
    () => (hasQuery ? [] : ranked.filter((coin) => followedIds.has(coin.stablecoinId))),
    [followedIds, hasQuery, ranked],
  );
  // Base stablecoins (including standalone yield-bearing coins); wrapper variants stay reachable through search.
  const suggestions = useMemo(
    () => (hasQuery ? [] : largestBaseCoins(ranked, followedIds)),
    [followedIds, hasQuery, ranked],
  );
  const shown = matches.slice(0, RESULT_LIMIT);

  return (
    <>
      <h1 tabIndex={-1} className="sr-only outline-none">Add or remove coins</h1>
      <div
        className={cn(
          "sticky top-0 z-chrome -mx-3 bg-[var(--mini-panel)] px-3 pt-[calc(var(--mini-safe-top)+0.75rem)] pb-3 sm:-mx-4 sm:px-4",
          !hasInlineBack && "-mt-[calc(var(--mini-safe-top)+0.75rem)]",
        )}
      >
        <label htmlFor="mini-coin-search" className="sr-only">Search stablecoins</label>
        <div className="flex h-11 items-center gap-2 rounded-xl bg-[var(--mini-card)] pl-3 pr-0.5 focus-within:ring-2 focus-within:ring-ring">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            id="mini-coin-search"
            type="search"
            autoComplete="off"
            enterKeyHint="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query.length > 0) {
                event.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Search 400+ coins: USDT, sUSDe, EURC"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                haptics?.selectionChanged?.();
                setQuery("");
                inputRef.current?.focus();
              }}
              className="pharos-focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:opacity-70"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {query.trim() ? (
        <ListSection
          title={matches.length > shown.length ? `Top ${shown.length} of ${matches.length} matches` : undefined}
          footer={matches.length === 0 ? "No match. Try a symbol like USDT, a name like Frax, or a peg like EUR." : undefined}
        >
          {shown.length > 0 ? shown.map(renderRow) : <ListRow title="No coins found" />}
        </ListSection>
      ) : (
        <>
          {selectedCoins.length > 0 ? (
            <ListSection
              title="Selected"
              trailing={changeCount >= CHANGE_COUNTER_THRESHOLD ? (
                <span className="pharos-numeric text-xs text-muted-foreground">
                  {changeCount} of {BULK_SELECTION_LIMIT} changes
                </span>
              ) : null}
            >
              {selectedCoins.map(renderRow)}
            </ListSection>
          ) : null}
          <ListSection title="Largest by market cap">{suggestions.map(renderRow)}</ListSection>
          {followed.length > 0 ? (
            <ListSection title="Your coins">{followed.map(renderRow)}</ListSection>
          ) : null}
        </>
      )}
      <p className="px-4 pt-3 text-xs leading-snug text-muted-foreground">
        {atLimit ? (
          <>Up to <span className="pharos-numeric">{BULK_SELECTION_LIMIT}</span> changes at a time. Save these first.</>
        ) : changeCount >= CHANGE_COUNTER_THRESHOLD ? (
          <><span className="pharos-numeric">{changeCount} of {BULK_SELECTION_LIMIT}</span> changes selected. New coins start with early-warning and depeg alerts.</>
        ) : (
          "New coins start with early-warning and depeg alerts. Fine-tune each coin afterwards."
        )}
      </p>
      {hasUnreadablePreset ? (
        <p className="px-4 pt-1.5 text-xs leading-snug text-muted-foreground">
          Some preset members can&apos;t be checked right now.
        </p>
      ) : null}
    </>
  );
}
