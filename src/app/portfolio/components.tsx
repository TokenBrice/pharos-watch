"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Share2, Trash2, Wallet, X } from "lucide-react";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { ReportCard, ReportCardGrade } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CoinSelector } from "@/components/coin-selector";
import { ReportCardMini } from "@/components/report-card-mini";
import { ReportCardRadar } from "@/components/radar-chart";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { UpstreamExposure } from "@/lib/portfolio-analysis";
import type { PortfolioHolding } from "@/lib/portfolio-codec";
import { formatUsd, parseUsdInput, PORTFOLIO_COIN_OPTIONS } from "./model";

const usdFormatterCompact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

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
  const inputValue = editing ? rawValue : amount > 0 ? usdFormatterCompact.format(amount) : "";

  const handleFocus = useCallback(() => {
    setEditing(true);
    setRawValue(amount > 0 ? String(amount) : "");
  }, [amount]);

  const handleBlur = useCallback(() => {
    setEditing(false);
    const parsed = parseUsdInput(rawValue);
    onSetAmount(coinId, parsed);
    setRawValue(parsed > 0 ? usdFormatterCompact.format(parsed) : "");
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
            className="pharos-focus-ring min-h-11 w-full rounded-md border bg-transparent pl-5 pr-2 py-2 text-right text-sm outline-none placeholder:text-muted-foreground sm:min-h-0 sm:w-28 sm:py-1.5"
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
    <Card>
      <CardHeader>
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary/80 shrink-0" />
            <CardTitle className="pharos-kicker">My Holdings</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" aria-live="polite" className="text-xs text-muted-foreground animate-in fade-in duration-300">
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
          <div className="rounded-2xl border border-dashed border-border/70 bg-muted/15 px-4 py-3 text-sm text-muted-foreground">
            Add holdings manually or load a starter mix below. Share and clear actions stay hidden until your portfolio
            has at least one position.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ExposureBar({
  name,
  symbol,
  usd,
  pct,
  isWarning,
  isCollateral,
}: {
  name: string;
  symbol: string;
  usd: number;
  pct: number;
  isWarning: boolean;
  isCollateral: boolean;
}) {
  const widthPct = Math.min(100, Math.round(pct));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate font-medium">
          {name}
          {!isCollateral && <span className="text-muted-foreground"> ({symbol})</span>}
          {isWarning && <AlertTriangle className="inline h-3 w-3 ml-1 text-amber-700 dark:text-amber-400" />}
        </span>
        <span className="text-muted-foreground ml-2 shrink-0">
          {formatUsd(usd)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={
            isCollateral
              ? "h-full rounded-full bg-[var(--chart-tertiary)]/50"
              : isWarning
                ? "h-full rounded-full bg-[var(--severity-mild)]/70"
                : "h-full rounded-full bg-[var(--chart-primary)]/50"
          }
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}

export function PortfolioSummaryCard({
  portfolioGrade,
  portfolioScore,
  totalUsd,
  radarCard,
  exposureToShow,
  showUpstreamDetail,
  onShowUpstreamDetailChange,
}: {
  portfolioGrade: ReportCardGrade;
  portfolioScore: number | null;
  totalUsd: number;
  radarCard: ReportCard | null;
  exposureToShow: UpstreamExposure[];
  showUpstreamDetail: boolean;
  onShowUpstreamDetailChange: (show: boolean) => void;
}) {
  const hasConcentrationWarning = exposureToShow.some((exposure) => !exposure.isCollateral && exposure.pct > 80);

  return (
    <Card>
      <CardContent className="pt-6 space-y-6">
        <div className="flex items-center gap-4">
          <ScoreBadgeWrapper topic="safetyScore">
            <Badge
              variant="outline"
              className={`text-2xl px-4 py-2 font-bold ${REPORT_CARD_GRADE_COLORS[portfolioGrade]}`}
              aria-label={`Safety grade ${portfolioGrade}${portfolioScore !== null ? `, score ${portfolioScore}` : ""}`}
            >
              {portfolioGrade}
              {portfolioScore !== null && (
                <span className="ml-1 opacity-70" aria-hidden="true">
                  ({portfolioScore})
                </span>
              )}
            </Badge>
          </ScoreBadgeWrapper>
          <div>
            <div className="text-sm text-muted-foreground">Portfolio Total</div>
            <div className="text-lg font-semibold">{formatUsd(totalUsd)}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {radarCard && (
            <div>
              <h3 className="pharos-kicker mb-2">Portfolio Radar</h3>
              <ReportCardRadar card={radarCard} size={260} labels="short" />
            </div>
          )}

          {exposureToShow.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="pharos-kicker">Upstream Exposure</h3>
                <div role="group" aria-label="Exposure view" className="inline-flex items-center rounded-md border bg-muted/30 p-0.5 gap-0.5">
                  <button
                    type="button"
                    aria-pressed={!showUpstreamDetail}
                    onClick={() => onShowUpstreamDetailChange(false)}
                    className={`pharos-focus-ring px-3 py-2 text-xs font-medium rounded-sm transition-colors ${!showUpstreamDetail ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    Summary
                  </button>
                  <button
                    type="button"
                    aria-pressed={showUpstreamDetail}
                    onClick={() => onShowUpstreamDetailChange(true)}
                    className={`pharos-focus-ring px-3 py-2 text-xs font-medium rounded-sm transition-colors ${showUpstreamDetail ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    Detail
                  </button>
                </div>
              </div>
              <div className="space-y-3">
                {exposureToShow.map((exposure) => (
                  <ExposureBar
                    key={exposure.coinId}
                    name={exposure.name}
                    symbol={exposure.symbol}
                    usd={exposure.usd}
                    pct={exposure.pct}
                    isWarning={!exposure.isCollateral && exposure.pct > 80}
                    isCollateral={exposure.isCollateral}
                  />
                ))}
              </div>
              {hasConcentrationWarning && (
                <div role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/20 dark:border-amber-500/40 bg-amber-500/5 dark:bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    High concentration: a single upstream stablecoin accounts for over 80% of your portfolio exposure.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function PortfolioGradesSection({
  heldCards,
  logos,
}: {
  heldCards: ReportCard[];
  logos?: Record<string, string>;
}) {
  return (
    <>
      <h2 className="pharos-kicker">Holdings Safety Grades</h2>

      {heldCards.length === 0 ? (
        <p className="text-sm text-muted-foreground">Grade data not yet available for your holdings.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {heldCards.map((card) => (
            <ReportCardMini key={card.id} card={card} logo={logos?.[card.id]} />
          ))}
        </div>
      )}
    </>
  );
}
