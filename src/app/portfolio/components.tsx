"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  GitCompareArrows,
  Network,
  Share2,
  ShieldCheck,
  Star,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { COIN_STATE_TONES } from "@shared/lib/classification";
import type { CoinState } from "@shared/lib/coin-state";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CoinSelector } from "@/components/coin-selector";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { CoinStateChip } from "@/components/coin-state-chip";
import type { PortfolioPreset } from "@/components/portfolio/portfolio-empty-state";
import type { PortfolioHolding } from "@/lib/portfolio-codec";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { formatDecimal } from "@shared/lib/format";
import {
  formatUsd,
  parseUsdInput,
  PORTFOLIO_COIN_OPTIONS,
  type ConcentrationTone,
  type ExceptionalHolding,
  type GroupedUpstreamExposure,
  type PortfolioConcentrationStrip,
} from "./model";

const AMOUNT_DEBOUNCE_MS = 250;

const CONCENTRATION_TONE_BAR_CLASS: Record<ConcentrationTone, string> = {
  danger: "bg-state-danger-solid",
  warn: "bg-state-warn-solid",
  info: "bg-state-info-solid",
  positive: "bg-state-positive-solid",
  "series-blue": "bg-[var(--chart-series-blue)]",
  "series-green": "bg-[var(--chart-series-green)]",
  "series-amber": "bg-[var(--chart-series-amber)]",
  "series-cyan": "bg-[var(--chart-series-cyan)]",
  "series-slate": "bg-[var(--chart-series-slate)]",
};

/**
 * Loaded-portfolio hero strip showing entered portfolio total, holding count,
 * and outbound cross-tool links (`Compare holdings`, `Trace upstream risks`).
 * Not rendered when the portfolio is empty so starter mixes and Watchlist
 * import sit directly above the fold.
 */
export function PortfolioHeroStrip({
  holdingCount,
  totalUsd,
  faceValueNote = false,
  compareHref,
  upstreamTraceHref,
}: {
  holdingCount: number;
  totalUsd: number;
  /** A holding is in an exceptional state, so the entered total may overstate what it is worth. */
  faceValueNote?: boolean;
  compareHref?: string;
  upstreamTraceHref?: string;
}) {
  if (holdingCount === 0) return null;
  return (
    <section className="pharos-card-shell px-5 py-5 sm:px-6 sm:py-5" aria-label="Portfolio overview">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1.5">
          <p className="pharos-label">Total portfolio value</p>
          <p className="pharos-hero-kpi pharos-numeric text-foreground">
            {totalUsd > 0 ? formatUsd(totalUsd) : "Enter amounts"}
          </p>
          <p className="pharos-meta">
            {faceValueNote
              ? "Sum of your entered amounts at face value, not live prices"
              : "Total portfolio value across your holdings"}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-4 sm:gap-5">
          <dl>
            <div className="space-y-1">
              <dt className="pharos-label">Holdings</dt>
              <dd className="pharos-numeric text-lg font-semibold text-foreground">{holdingCount}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            {compareHref ? (
              <Link
                href={compareHref}
                className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs font-medium sm:min-h-8"
              >
                <GitCompareArrows className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Compare holdings</span>
              </Link>
            ) : null}
            {upstreamTraceHref ? (
              <Link
                href={upstreamTraceHref}
                className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs font-medium sm:min-h-8"
              >
                <Network className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Trace upstream risks</span>
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Lists the holdings in an exceptional state (`resolveCoinStates`), largest
 * entered exposure first, ahead of every portfolio figure. The callout takes
 * the loudest tone among the states it lists.
 */
export function PortfolioStateCallout({ holdings, totalUsd }: { holdings: readonly ExceptionalHolding[]; totalUsd: number }) {
  if (holdings.length === 0) return null;
  const tones = new Set(holdings.flatMap((holding) => holding.states.map((state) => COIN_STATE_TONES[state.kind])));
  const tone = tones.has("danger") ? "danger" : tones.has("caution") ? "caution" : "neutral";
  const exposureUsd = holdings.reduce((sum, holding) => sum + holding.amount, 0);
  return (
    <section
      aria-label="Holdings in an exceptional state"
      className={cn("rounded-xl border px-4 py-3 text-sm text-foreground", SEVERITY_TONE_CLASS[tone].banner)}
    >
      <p className="font-medium">
        {holdings.length} {holdings.length === 1 ? "holding is" : "holdings are"} in an exceptional state
        {exposureUsd > 0 && totalUsd > 0 ? ` · ${formatUsd(exposureUsd)} of ${formatUsd(totalUsd)} entered` : ""}
      </p>
      <ul className="mt-2 space-y-1.5">
        {holdings.map((holding) => (
          <li key={holding.coinId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{TRACKED_META_BY_ID.get(holding.coinId)?.symbol ?? holding.coinId}</span>
            <span className="pharos-numeric text-xs text-muted-foreground">
              {holding.amount > 0 ? formatUsd(holding.amount) : "No amount entered"}
            </span>
            {holding.states.map((state, index) => (
              <CoinStateChip key={state.kind} state={state} showDetail={index === 0} />
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Compact neutral callout linking held coins that have a published failure
 * scenario to their dossier `#how-it-breaks` section plus the `/learn/scenarios/`
 * hub. Renders nothing when no held coins match.
 */
export function PortfolioFailureScenariosCallout({ coinIds }: { coinIds: readonly string[] }) {
  if (coinIds.length === 0) return null;
  return (
    <section
      aria-labelledby="portfolio-failure-scenarios-heading"
      className={cn("rounded-xl border px-4 py-3 text-sm text-foreground", SEVERITY_TONE_CLASS.neutral.banner)}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p id="portfolio-failure-scenarios-heading" className="font-medium">
          Failure scenarios for your holdings ({coinIds.length})
        </p>
        <Link
          href="/learn/scenarios/"
          className="pharos-focus-ring inline-flex min-h-9 items-center rounded-sm text-xs font-medium text-brand-accent-text underline-offset-4 hover:underline sm:min-h-7"
        >
          All scenarios
        </Link>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Curated hypothetical failure paths in each coin&apos;s dossier. Not Safety Score inputs.
      </p>
      <ul className="mt-2.5 flex flex-wrap items-center gap-2">
        {coinIds.map((coinId) => {
          const symbol = TRACKED_META_BY_ID.get(coinId)?.symbol ?? coinId;
          return (
            <li key={coinId}>
              <Link
                href={`${buildStablecoinUrl(coinId)}#how-it-breaks`}
                className="pharos-focus-ring pharos-control-pill inline-flex min-h-9 items-center gap-1 px-2.5 py-1 text-xs font-medium sm:min-h-7"
              >
                <span>{symbol}</span>
                <span className="sr-only"> failure scenario</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PortfolioLoadingState() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading portfolio data">
      <Skeleton className="h-[194px] w-full rounded-xl sm:h-[140px]" />
      <Skeleton className="h-[250px] w-full rounded-xl sm:h-[170px]" />
      <Skeleton className="h-[1250px] w-full rounded-xl sm:h-[510px]" />
    </div>
  );
}

function HoldingRow({
  coinId,
  amount,
  totalUsd,
  autoFocus = false,
  onAutoFocusHandled,
  state,
  logos,
  onSetAmount,
  onRemove,
}: {
  coinId: string;
  amount: number;
  totalUsd: number;
  autoFocus?: boolean;
  onAutoFocusHandled?: () => void;
  state?: CoinState;
  logos?: Record<string, string>;
  onSetAmount: (coinId: string, amount: number) => void;
  onRemove: (coinId: string) => void;
}) {
  const meta = TRACKED_META_BY_ID.get(coinId);
  const [editing, setEditing] = useState(false);
  const [rawValue, setRawValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputValue = editing ? rawValue : amount > 0 ? formatDecimal(amount) : "";

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    onAutoFocusHandled?.();
  }, [autoFocus, onAutoFocusHandled]);

  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  }, []);

  const handleFocus = useCallback(() => {
    setEditing(true);
    setRawValue(amount > 0 ? String(amount) : "");
  }, [amount]);

  const handleBlur = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setEditing(false);
    const parsed = parseUsdInput(rawValue);
    onSetAmount(coinId, parsed);
    setRawValue(parsed > 0 ? formatDecimal(parsed) : "");
  }, [rawValue, coinId, onSetAmount]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const nextRaw = e.target.value;
      setRawValue(nextRaw);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        onSetAmount(coinId, parseUsdInput(nextRaw));
      }, AMOUNT_DEBOUNCE_MS);
    },
    [coinId, onSetAmount],
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") inputRef.current?.blur();
  }, []);

  if (!meta) return null;

  const weightLabel = totalUsd > 0 ? `${((amount / totalUsd) * 100).toFixed(1)}%` : "—";

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/35 p-3 sm:flex-row sm:items-center sm:border-0 sm:bg-transparent sm:p-0 sm:py-2">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <StablecoinLogo src={logos?.[coinId]} name={meta.name} size={24} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{meta.name}</div>
          <div className="text-xs text-muted-foreground">{meta.symbol}</div>
          {state ? <CoinStateChip state={state} className="mt-1" /> : null}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:shrink-0">
        <span
          className="pharos-numeric w-14 text-right text-xs font-medium text-muted-foreground"
          aria-label={totalUsd > 0 ? `${meta.symbol} portfolio weight ${weightLabel}` : `${meta.symbol} portfolio weight unavailable`}
          title={totalUsd > 0 ? `${weightLabel} of portfolio` : "Enter amounts to see portfolio weights"}
        >
          {weightLabel}
        </span>
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
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
            className="pharos-numeric pharos-focus-ring min-h-11 w-full rounded-md border border-border/60 bg-transparent py-2 pl-5 pr-2 text-right text-sm outline-none placeholder:text-muted-foreground sm:min-h-0 sm:w-28 sm:py-1.5"
            aria-label={`Amount in USD for ${meta.name}`}
          />
        </div>
        <button
          type="button"
          onClick={() => onRemove(coinId)}
          className="pharos-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive sm:min-h-0 sm:min-w-0 sm:p-1"
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
  totalUsd,
  heldCardIds,
  autoFocusCoinId,
  onAutoFocusHandled,
  coinStatesById,
  logos,
  toast,
  shareFallbackUrl,
  onDismissShareFallback,
  presets,
  onApplyPreset,
  importableWatchlistCount = 0,
  onImportWatchlist,
  onSetAmount,
  onRemove,
  onSelectCoin,
  onShare,
  onClear,
}: {
  holdings: PortfolioHolding[];
  totalUsd: number;
  heldCardIds: Set<string>;
  autoFocusCoinId?: string | null;
  onAutoFocusHandled?: () => void;
  coinStatesById?: ReadonlyMap<string, readonly CoinState[]>;
  logos?: Record<string, string>;
  toast: string | null;
  shareFallbackUrl?: string | null;
  onDismissShareFallback?: () => void;
  presets?: readonly PortfolioPreset[];
  onApplyPreset?: (preset: PortfolioPreset) => void;
  importableWatchlistCount?: number;
  onImportWatchlist?: () => void;
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
            <Wallet className="h-5 w-5 shrink-0 text-primary/80" />
            <CardTitle className="pharos-label">My holdings</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" aria-live="polite" className="animate-fade-in text-xs text-muted-foreground">
              {toast}
            </span>
            {importableWatchlistCount > 0 && onImportWatchlist ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onImportWatchlist}
                className="pharos-focus-ring min-h-11 gap-1.5 sm:min-h-8"
              >
                <Star className="h-3.5 w-3.5" aria-hidden="true" />
                Import my Watchlist ({importableWatchlistCount})
              </Button>
            ) : null}
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
        {shareFallbackUrl ? (
          <div
            role="region"
            aria-label="Shareable portfolio link"
            className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs sm:flex-row sm:items-center"
          >
            <label className="min-w-0 flex-1 space-y-1">
              <span className="block font-medium text-foreground">
                Clipboard access was blocked. Copy this link manually:
              </span>
              <input
                readOnly
                value={shareFallbackUrl}
                onFocus={(event) => event.currentTarget.select()}
                className="pharos-focus-ring w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-2xs text-foreground"
              />
            </label>
            {onDismissShareFallback ? (
              <button
                type="button"
                onClick={onDismissShareFallback}
                aria-label="Dismiss share link"
                className="pharos-focus-ring inline-flex min-h-9 items-center justify-center self-end rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground sm:self-center"
              >
                Done
              </button>
            ) : null}
          </div>
        ) : null}

        {holdings.map((holding) => (
          <HoldingRow
            key={holding.coinId}
            coinId={holding.coinId}
            amount={holding.amount}
            totalUsd={totalUsd}
            autoFocus={holding.coinId === autoFocusCoinId}
            onAutoFocusHandled={onAutoFocusHandled}
            state={coinStatesById?.get(holding.coinId)?.[0]}
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
          <div className="space-y-3">
            {presets && presets.length > 0 && onApplyPreset ? (
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Starter mixes">
                <span className="pharos-label mr-1">Starter mixes</span>
                {presets.map((preset) => (
                  <button
                    key={preset.title}
                    type="button"
                    onClick={() => onApplyPreset(preset)}
                    className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs font-medium sm:min-h-8"
                  >
                    <ShieldCheck className="h-3.5 w-3.5 text-primary/80" aria-hidden="true" />
                    <span>{preset.title}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="pharos-empty-note border-dashed px-4 py-3 text-sm">
              Add holdings manually or load a starter mix below. Share and clear actions stay hidden until your portfolio
              has at least one position.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Surfaces the already-computed `dependencyExposure[]` routes grouped by
 * upstream asset, preserving unknown basket shares explicitly (R1).
 */
export function PortfolioUpstreamExposureCard({
  groups,
  totalRoutes,
  logos,
}: {
  groups: readonly GroupedUpstreamExposure[];
  totalRoutes: number;
  logos?: Record<string, string>;
}) {
  return (
    <Card className="pharos-card-shell">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <CardTitle className="pharos-label">Upstream collateral exposure</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {groups.length === 0
                ? "No modeled upstream exposure routes across these holdings."
                : `${groups.length} upstream ${groups.length === 1 ? "asset" : "assets"} across ${totalRoutes} modeled ${totalRoutes === 1 ? "route" : "routes"}. Unknown basket shares stay unmeasured, never $0.`}
            </p>
          </div>
        </div>
      </CardHeader>
      {groups.length > 0 ? (
        <CardContent className="pt-0">
          <ul className="divide-y divide-border/50" aria-label="Upstream collateral exposure by asset">
            {groups.map((group) => {
              const upstreamMeta = TRACKED_META_BY_ID.get(group.upstreamAssetId);
              const upstreamSymbol = upstreamMeta?.symbol ?? group.upstreamAssetId;
              const upstreamName = upstreamMeta?.name ?? group.upstreamAssetId;
              const traceHref = `/dependency-map/?mode=exposure&root=${encodeURIComponent(group.upstreamAssetId)}`;

              return (
                <li
                  key={group.upstreamAssetId}
                  className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-2.5 lg:w-52 lg:shrink-0">
                    <StablecoinLogo src={logos?.[group.upstreamAssetId]} name={upstreamName} size={24} />
                    <div className="min-w-0">
                      <Link
                        href={buildStablecoinUrl(group.upstreamAssetId)}
                        className="pharos-focus-ring block truncate rounded-sm text-sm font-semibold text-foreground hover:text-brand-accent-text hover:underline"
                      >
                        {upstreamSymbol}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">{upstreamName}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 lg:w-56 lg:shrink-0">
                    <div>
                      <p className="text-3xs uppercase tracking-wide text-muted-foreground">Known exposure</p>
                      <p className="pharos-numeric text-sm font-semibold text-foreground">
                        {group.knownExposureUsd === null ? "Unavailable" : formatUsd(group.knownExposureUsd)}
                      </p>
                      {group.hasUnknownShareRoutes ? (
                        <p className="text-3xs text-muted-foreground">
                          +{group.unknownRouteCount} unmeasured {group.unknownRouteCount === 1 ? "route" : "routes"}
                        </p>
                      ) : null}
                    </div>
                    <div>
                      <p className="text-3xs uppercase tracking-wide text-muted-foreground">% of book</p>
                      <p className="pharos-numeric text-sm font-medium text-foreground">
                        {group.pctOfPortfolio === null ? "—" : `${group.pctOfPortfolio.toFixed(1)}%`}
                      </p>
                    </div>
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="text-3xs uppercase tracking-wide text-muted-foreground">Contributing holdings</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {group.contributors.map((contributor) => {
                        const depMeta = TRACKED_META_BY_ID.get(contributor.dependentAssetId);
                        const depSymbol = depMeta?.symbol ?? contributor.dependentAssetId;
                        return (
                          <span
                            key={`${group.upstreamAssetId}:${contributor.dependentAssetId}:${contributor.kind}`}
                            className="inline-flex items-baseline gap-1 rounded-full border border-border/60 bg-muted/35 px-2 py-0.5 text-2xs text-foreground"
                          >
                            <span className="font-semibold">{depSymbol}</span>
                            <span className="pharos-numeric text-muted-foreground">
                              {contributor.exposureUsd === null ? "share unmeasured" : formatUsd(contributor.exposureUsd)}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  <div className="shrink-0">
                    <Link
                      href={traceHref}
                      className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-md text-xs font-medium text-brand-accent-text underline-offset-4 hover:underline sm:min-h-8"
                    >
                      <span>Trace on Dependency Map{"\u00a0\u2192"}</span>
                      <ArrowRight className="sr-only h-3 w-3" aria-hidden="true" />
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}

/**
 * Client-computed Freeze, Governance, Custody, and Peg concentration strips.
 * Unreviewed/unknown holdings render as a distinct dashed tail and explicit
 * caption rather than being silently renormalized or coerced to zero.
 */
export function PortfolioConcentrationCard({
  strips,
}: {
  strips: readonly PortfolioConcentrationStrip[];
}) {
  if (strips.length === 0) return null;

  return (
    <Card className="pharos-card-shell">
      <CardHeader className="pb-3">
        <CardTitle className="pharos-label">Portfolio concentration</CardTitle>
        <p className="text-xs text-muted-foreground">
          Weighted by entered USD amounts. Unreviewed or unknown attributes remain separate from known totals.
        </p>
      </CardHeader>
      <CardContent className="grid gap-5 pt-0 md:grid-cols-2">
        {strips.map((strip) => (
          <div key={strip.id} className="space-y-2" data-testid={`portfolio-concentration-${strip.id}`}>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-semibold text-foreground">{strip.title}</p>
              {strip.unavailableUsd > 0 ? (
                <span className="pharos-numeric text-2xs text-muted-foreground">
                  {((strip.knownUsd / strip.totalUsd) * 100).toFixed(0)}% reviewed
                </span>
              ) : null}
            </div>

            <div
              className="flex h-2.5 w-full overflow-hidden rounded-full border border-meter-track-border bg-meter-track"
              role="img"
              aria-label={`${strip.title} breakdown`}
            >
              {strip.buckets.map((bucket) => (
                <div
                  key={bucket.key}
                  className={cn("h-full min-w-1", CONCENTRATION_TONE_BAR_CLASS[bucket.tone])}
                  style={{ width: `${bucket.sharePct}%` }}
                  title={`${bucket.label}: ${bucket.sharePct.toFixed(1)}% (${formatUsd(bucket.amountUsd)})`}
                />
              ))}
              {strip.unavailableUsd > 0 ? (
                <div
                  className="h-full min-w-1 border-l border-dashed border-muted-foreground/60 bg-muted/60"
                  style={{ width: `${strip.unavailableSharePct}%` }}
                  title={`Unavailable / unreviewed: ${strip.unavailableSharePct.toFixed(1)}% (${formatUsd(strip.unavailableUsd)})`}
                />
              ) : null}
            </div>

            <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
              {strip.buckets.map((bucket) => (
                <span key={bucket.key} className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn("inline-block size-2 shrink-0 rounded-full", CONCENTRATION_TONE_BAR_CLASS[bucket.tone])}
                  />
                  <span className="font-medium text-foreground">{bucket.label}</span>
                  <span className="pharos-numeric">{bucket.sharePct.toFixed(1)}%</span>
                </span>
              ))}
              {strip.unavailableUsd > 0 ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block size-2 shrink-0 rounded-full border border-dashed border-muted-foreground/70 bg-muted"
                  />
                  <span>
                    Unreviewed ({strip.unavailableIds.map((id) => TRACKED_META_BY_ID.get(id)?.symbol ?? id).join(", ")})
                  </span>
                  <span className="pharos-numeric">{strip.unavailableSharePct.toFixed(1)}%</span>
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
