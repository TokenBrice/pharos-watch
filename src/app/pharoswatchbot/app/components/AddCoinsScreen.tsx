"use client";

import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { BULK_SELECTION_LIMIT, presetLabel } from "../constants";
import { usePrimaryAction } from "../primary-action";
import type { CatalogCoin, MiniAppScreenProps } from "../types";
import { ListRow, ListSection } from "./List";

const RESULT_LIMIT = 40;
const SUGGESTION_LIMIT = 15;

/** Exact symbol, then prefix, then substring; ties keep market-cap order. */
export function searchCatalog(coins: readonly CatalogCoin[], query: string): CatalogCoin[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return coins
    .map((coin) => {
      const symbol = coin.symbol.toLowerCase();
      const name = coin.name.toLowerCase();
      const bucket = symbol === q ? 0
        : symbol.startsWith(q) ? 1
          : name.startsWith(q) ? 2
            : symbol.includes(q) || name.includes(q) || coin.stablecoinId.includes(q) ? 3
              : null;
      return bucket == null ? null : { coin, bucket };
    })
    .filter((match): match is { coin: CatalogCoin; bucket: number } => match != null)
    .sort((left, right) => left.bucket - right.bucket
      || (left.coin.rank ?? Number.MAX_SAFE_INTEGER) - (right.coin.rank ?? Number.MAX_SAFE_INTEGER))
    .map((match) => match.coin);
}

/** The default list: the largest unfollowed base stablecoins, without wrapped or yield-bearing variants. */
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
}

/** One multi-select over the catalog: tick to add, untick a followed coin to remove. */
export function AddCoinsScreen({ state, canEdit, busy, pendingOperation, onApply, onDone }: AddCoinsScreenProps) {
  const [query, setQuery] = useState("");
  const [adds, setAdds] = useState<string[]>([]);
  const [removes, setRemoves] = useState<string[]>([]);
  const followedIds = useMemo(() => new Set(state.subscriptions.map((coin) => coin.stablecoinId)), [state.subscriptions]);
  const ranked = useMemo(
    () => [...state.catalog.searchableCoins].sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)),
    [state.catalog.searchableCoins],
  );
  const presetMembers = useMemo(() => {
    const members = new Map<string, string>();
    for (const preset of state.presets) for (const id of preset.memberIds ?? []) if (!members.has(id)) members.set(id, presetLabel(preset.id, preset.label));
    return members;
  }, [state.presets]);
  const matches = useMemo(() => searchCatalog(ranked, query), [query, ranked]);
  const changeCount = adds.length + removes.length;
  const atLimit = changeCount >= BULK_SELECTION_LIMIT;
  const applying = pendingOperation?.kind === "preview-bulk-watchlist" || pendingOperation?.kind === "confirm-bulk-watchlist";

  usePrimaryAction(canEdit && changeCount > 0 ? {
    text: countLabel(adds.length, removes.length),
    progress: applying,
    onClick: () => {
      if (busy) return;
      void onApply(adds, removes).then((saved) => {
        if (saved) onDone();
      });
    },
  } : null);

  const isSelected = (id: string) => (followedIds.has(id) ? !removes.includes(id) : adds.includes(id));
  const toggle = (id: string) => {
    const followed = followedIds.has(id);
    const setter = followed ? setRemoves : setAdds;
    setter((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      return atLimit ? current : [...current, id];
    });
  };

  const renderRow = (coin: Pick<CatalogCoin, "stablecoinId" | "symbol" | "name"> & { peg?: string | null }) => {
    const id = coin.stablecoinId;
    const following = followedIds.has(id);
    const selected = isSelected(id);
    const changed = adds.includes(id) || removes.includes(id);
    // "In USD Top 25" only matters when deciding whether to add a coin.
    const preset = following ? undefined : presetMembers.get(id);
    const status = following ? (changed ? "Will be removed" : "Following") : changed ? "Will be added" : null;
    return (
      <ListRow
        key={id}
        ariaChecked={selected}
        ariaLabel={`${coin.symbol} ${coin.name}${status ? `, ${status.toLowerCase()}` : ""}`}
        disabled={!canEdit || busy || (!changed && atLimit)}
        className="min-h-[3.25rem]"
        leading={(
          <span
            aria-hidden="true"
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors",
              // Already-followed coins use a quiet check so the new picks stand out and match the count.
              selected && !following && "border-transparent bg-[var(--telegram-button,var(--mini-accent))] text-[color:var(--telegram-button-text,white)]",
              selected && following && "border-transparent bg-[color-mix(in_oklab,var(--mini-text)_18%,var(--mini-card))] text-foreground",
              !selected && "border-[color:var(--border)]",
            )}
          >
            {selected ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
          </span>
        )}
        title={<><span className="font-medium">{coin.symbol}</span> <span className="text-muted-foreground">{coin.name !== coin.symbol ? coin.name : ""}</span></>}
        subtitle={[status, coin.peg ? `${coin.peg} peg` : null, preset ? `In ${preset}` : null].filter(Boolean).join(" · ") || undefined}
        onClick={() => toggle(id)}
      />
    );
  };

  const followed = ranked.filter((coin) => followedIds.has(coin.stablecoinId));
  // Base stablecoins only; wrapped and yield-bearing variants stay reachable through search.
  const suggestions = largestBaseCoins(ranked, followedIds);
  const shown = matches.slice(0, RESULT_LIMIT);

  return (
    <>
      <div className="sticky top-[calc(env(safe-area-inset-top)+var(--telegram-safe-area-top,0px))] z-chrome -mx-3 bg-[var(--mini-panel)] px-3 pt-2 pb-3 sm:-mx-4 sm:px-4">
        <label htmlFor="mini-coin-search" className="sr-only">Search stablecoins</label>
        <div className="flex h-11 items-center gap-2 rounded-xl bg-[var(--mini-card)] px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            id="mini-coin-search"
            type="search"
            // Focus lands in the search box when the screen opens, like a native search sheet.
            autoFocus
            autoComplete="off"
            enterKeyHint="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by symbol or name"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {query.trim() ? (
        <ListSection
          title={matches.length > shown.length ? `Top ${shown.length} of ${matches.length} matches` : undefined}
          footer={matches.length === 0 ? "No match. Try a symbol like USDT or a name like Frax." : undefined}
        >
          {shown.length > 0 ? shown.map(renderRow) : <ListRow title="No coins found" />}
        </ListSection>
      ) : (
        <>
          {followed.length > 0 ? (
            <ListSection title="Your coins">{followed.map(renderRow)}</ListSection>
          ) : null}
          <ListSection title="Largest stablecoins">{suggestions.map(renderRow)}</ListSection>
        </>
      )}
      <p className="px-4 pt-3 text-xs leading-snug text-muted-foreground">
        {atLimit
          ? `Up to ${BULK_SELECTION_LIMIT} changes at a time. Save these first.`
          : "New coins start with early-warning and depeg alerts. Fine-tune each coin afterwards."}
      </p>
    </>
  );
}
