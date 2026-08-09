"use client";

import { useCallback, useRef, useState } from "react";
import { Share2, Trash2, Wallet, X } from "lucide-react";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CoinSelector } from "@/components/coin-selector";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { PortfolioHolding } from "@/lib/portfolio-codec";
import { formatDecimal } from "@shared/lib/format";
import { formatUsd, parseUsdInput, PORTFOLIO_COIN_OPTIONS } from "./model";

/**
 * Compact "One Beam" hero strip for /portfolio (the beam-header-strip variant of
 * the FeatureHeroSplit pattern — full-width, no forced right slot). Once holdings
 * exist the beam is the live Total Portfolio Value; before that it lights the
 * size of the gradeable registry the portfolio can draw from.
 */
export function PortfolioHeroStrip({ holdingCount, totalUsd }: { holdingCount: number; totalUsd: number }) {
  const hasHoldings = holdingCount > 0;
  return (
    <section className="pharos-card-shell px-5 py-5 sm:px-6 sm:py-6" aria-label="Portfolio overview">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="pharos-kicker">Portfolio Risk</p>
          <p className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]">
            {hasHoldings ? formatUsd(totalUsd) : PORTFOLIO_COIN_OPTIONS.length}
          </p>
          <p className="pharos-meta">
            {hasHoldings
              ? "Total portfolio value across your holdings"
              : "Active stablecoins you can model as holdings"}
          </p>
        </div>
        <dl>
          <div className="space-y-1">
            <dt className="pharos-kicker">Holdings</dt>
            <dd className="pharos-numeric text-lg font-semibold text-foreground">{holdingCount}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

export function PortfolioLoadingState() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading portfolio data">
      <Card>
        <CardContent className="pt-4 pb-4 space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function HoldingRow({
  coinId,
  amount,
  logos,
  onSetAmount,
  onRemove,
}: {
  coinId: string;
  amount: number;
  logos?: Record<string, string>;
  onSetAmount: (coinId: string, amount: number) => void;
  onRemove: (coinId: string) => void;
}) {
  const meta = TRACKED_META_BY_ID.get(coinId);
  const [editing, setEditing] = useState(false);
  const [rawValue, setRawValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputValue = editing ? rawValue : amount > 0 ? formatDecimal(amount) : "";

  const handleFocus = useCallback(() => {
    setEditing(true);
    setRawValue(amount > 0 ? String(amount) : "");
  }, [amount]);

  const handleBlur = useCallback(() => {
    setEditing(false);
    const parsed = parseUsdInput(rawValue);
    onSetAmount(coinId, parsed);
    setRawValue(parsed > 0 ? formatDecimal(parsed) : "");
  }, [rawValue, coinId, onSetAmount]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRawValue(e.target.value);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") inputRef.current?.blur();
  }, []);

  if (!meta) return null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/35 p-3 sm:flex-row sm:items-center sm:border-0 sm:bg-transparent sm:p-0 sm:py-2">
      <StablecoinLogo src={logos?.[coinId]} name={meta.name} size={24} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{meta.name}</div>
        <div className="text-xs text-muted-foreground">{meta.symbol}</div>
      </div>
      <div className="flex items-center gap-2 sm:shrink-0">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">
            $
          </span>
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={inputValue}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="0"
            className="pharos-numeric pharos-focus-ring min-h-11 w-full rounded-md border border-border/60 bg-transparent pl-5 pr-2 py-2 text-right text-sm outline-none placeholder:text-muted-foreground sm:min-h-0 sm:w-28 sm:py-1.5"
            aria-label={`Amount in USD for ${meta.name}`}
          />
        </div>
        <button type="button"
          onClick={() => onRemove(coinId)}
          className="pharos-focus-ring text-muted-foreground hover:text-destructive transition-colors min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 sm:p-1 flex items-center justify-center rounded"
          aria-label={`Remove ${meta.name}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function PortfolioHoldingsEditor({
  holdings,
  heldCardIds,
  logos,
  toast,
  onSetAmount,
  onRemove,
  onSelectCoin,
  onShare,
  onClear,
}: {
  holdings: PortfolioHolding[];
  heldCardIds: Set<string>;
  logos?: Record<string, string>;
  toast: string | null;
  onSetAmount: (coinId: string, amount: number) => void;
  onRemove: (coinId: string) => void;
  onSelectCoin: (coin: { id: string }) => void;
  onShare: () => void;
  onClear: () => void;
}) {
  return (
    <Card className="pharos-card-shell">
      <CardHeader>
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary/80 shrink-0" />
            <CardTitle className="pharos-kicker">My Holdings</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" aria-live="polite" className="text-xs text-muted-foreground animate-fade-in">
              {toast}
            </span>
            {holdings.length > 0 && (
              <>
                <Button variant="outline" size="sm" onClick={onShare} className="pharos-focus-ring min-h-11 sm:min-h-8">
                  <Share2 className="h-3.5 w-3.5" />
                  Share
                </Button>
                <Button variant="ghost" size="sm" onClick={onClear} className="pharos-focus-ring min-h-11 text-muted-foreground sm:min-h-8">
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {holdings.map((holding) => (
          <HoldingRow
            key={holding.coinId}
            coinId={holding.coinId}
            amount={holding.amount}
            logos={logos}
            onSetAmount={onSetAmount}
            onRemove={onRemove}
          />
        ))}
        <CoinSelector
          coins={PORTFOLIO_COIN_OPTIONS}
          selected={null}
          logos={logos}
          disabledIds={heldCardIds}
          onSelect={onSelectCoin}
          onRemove={() => {}}
        />
        {holdings.length === 0 && (
          <div className="pharos-empty-note border-dashed px-4 py-3 text-sm">
            Add holdings manually or load a starter mix below. Share and clear actions stay hidden until your portfolio
            has at least one position.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
