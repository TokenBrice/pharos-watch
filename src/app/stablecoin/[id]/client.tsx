"use client";

import Link from "next/link";
import { ArrowLeft, ExternalLink, Globe } from "lucide-react";
import { useStablecoinDetail, useStablecoins } from "@/hooks/use-stablecoins";
import { useDepegEvents } from "@/hooks/use-depeg-events";
import { findStablecoinMeta, TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { formatCurrency, formatNativePrice, formatPegDeviation, formatPercentChange, formatSupply } from "@/lib/format";
import { derivePegRates, getPegReference } from "@/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw, getPrevMonthRaw } from "@/lib/supply";
import { computePegScore } from "@/lib/peg-score";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { SupplyChart } from "@/components/supply-chart";

import { ChainDistribution } from "@/components/chain-distribution";
import { DepegHistory } from "@/components/depeg-history";
import { DexLiquidityCard } from "@/components/dex-liquidity-card";
import { useBluechipRatings } from "@/hooks/use-bluechip-ratings";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { BLUECHIP_REPORT_BASE, GRADE_ORDER } from "@/lib/bluechip";
import type { StablecoinData, StablecoinMeta } from "@/lib/types";


// --- Category colors (matching main page badges) ---

const GOVERNANCE_STYLE: Record<string, { label: string; cls: string }> = {
  centralized: { label: "Centralized", cls: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20" },
  "centralized-dependent": { label: "CeFi-Dependent", cls: "bg-orange-500/10 text-orange-500 border-orange-500/20" },
  decentralized: { label: "Decentralized", cls: "bg-green-500/10 text-green-500 border-green-500/20" },
};

const BACKING_STYLE: Record<string, { label: string; cls: string }> = {
  "rwa-backed": { label: "RWA-Backed", cls: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
  "crypto-backed": { label: "Crypto-Backed", cls: "bg-purple-500/10 text-purple-500 border-purple-500/20" },
  algorithmic: { label: "Algorithmic", cls: "bg-orange-500/10 text-orange-500 border-orange-500/20" },
};

const PEG_STYLE: Record<string, { label: string; cls: string }> = {
  USD: { label: "USD Peg", cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
  EUR: { label: "EUR Peg", cls: "bg-violet-500/10 text-violet-500 border-violet-500/20" },
  GOLD: { label: "Gold Peg", cls: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20" },
  CHF: { label: "CHF Peg", cls: "bg-pink-500/10 text-pink-500 border-pink-500/20" },
  GBP: { label: "GBP Peg", cls: "bg-cyan-500/10 text-cyan-500 border-cyan-500/20" },
  BRL: { label: "BRL Peg", cls: "bg-orange-500/10 text-orange-500 border-orange-500/20" },
  RUB: { label: "RUB Peg", cls: "bg-red-500/10 text-red-500 border-red-500/20" },
  VAR: { label: "Variable Peg", cls: "bg-sky-500/10 text-sky-500 border-sky-500/20" },
  OTHER: { label: "Other Peg", cls: "bg-slate-500/10 text-slate-500 border-slate-500/20" },
};

const POR_STYLE: Record<string, { label: string; cls: string }> = {
  "independent-audit": { label: "Independent Audit", cls: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
  "real-time": { label: "Real-Time PoR", cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
  "self-reported": { label: "Self-Reported PoR", cls: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
};

function MechanismCard({ meta }: { meta: StablecoinMeta }) {
  const gov = GOVERNANCE_STYLE[meta.flags.governance];
  const backing = BACKING_STYLE[meta.flags.backing];
  const peg = PEG_STYLE[meta.flags.pegCurrency];
  const hasDescription = meta.collateral || meta.pegMechanism;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Classification & Mechanism</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {gov && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${gov.cls}`}>{gov.label}</span>}
          {backing && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${backing.cls}`}>{backing.label}</span>}
          {peg && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${peg.cls}`}>{peg.label}</span>}
          {meta.flags.yieldBearing && <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Yield-Bearing</span>}
          {meta.flags.rwa && <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-sky-500/10 text-sky-500 border-sky-500/20">RWA</span>}
          {meta.flags.governance !== "decentralized" && (
            meta.proofOfReserves ? (
              <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${POR_STYLE[meta.proofOfReserves.type].cls}`}>
                {POR_STYLE[meta.proofOfReserves.type].label}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-red-500/10 text-red-500 border-red-500/20">
                No PoR
              </span>
            )
          )}
        </div>

        {hasDescription && (
          <div className="grid gap-4 sm:grid-cols-2">
            {meta.collateral && (
              <div className="rounded-xl bg-muted/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Collateral</p>
                <p className="text-sm leading-relaxed">{meta.collateral}</p>
              </div>
            )}
            {meta.pegMechanism && (
              <div className="rounded-xl bg-muted/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Peg Stability</p>
                <p className="text-sm leading-relaxed">{meta.pegMechanism}</p>
              </div>
            )}
          </div>
        )}

        {meta.flags.governance !== "decentralized" && (
          <div className="rounded-xl bg-muted/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Proof of Reserves</p>
            {meta.proofOfReserves ? (
              <div className="space-y-1">
                <p className="text-sm leading-relaxed">
                  {POR_STYLE[meta.proofOfReserves.type].label}
                  {meta.proofOfReserves.provider && ` by ${meta.proofOfReserves.provider}`}
                </p>
                <a
                  href={meta.proofOfReserves.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-500 hover:underline"
                >
                  View reserves <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No proof of reserves published</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function IssuerInfoCard({ meta }: { meta: StablecoinMeta }) {
  const isDecentralized = meta.flags.governance === "decentralized";
  const hasLinks = meta.links && meta.links.length > 0;
  const hasJurisdiction = !isDecentralized && meta.jurisdiction;

  if (!hasLinks && !hasJurisdiction) return null;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Issuer Info</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasJurisdiction && meta.jurisdiction && (
          <div className="rounded-xl bg-muted/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Jurisdiction</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{meta.jurisdiction.country}</span>
              {meta.jurisdiction.regulator && (
                <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-blue-500/10 text-blue-500 border-blue-500/20">
                  {meta.jurisdiction.regulator}
                </span>
              )}
              {meta.jurisdiction.license && (
                <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-violet-500/10 text-violet-500 border-violet-500/20">
                  {meta.jurisdiction.license}
                </span>
              )}
            </div>
          </div>
        )}

        {hasLinks && (
          <div className="flex flex-wrap gap-3">
            {meta.links!.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
              >
                {link.label === "Website" ? (
                  <Globe className="h-3.5 w-3.5" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
                {link.label}
              </a>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BluechipBox({ stablecoinId, ratingsMap }: { stablecoinId: string; ratingsMap: import("@/lib/types").BluechipRatingsMap | undefined | null }) {
  const rating = ratingsMap?.[stablecoinId];
  if (!rating) return null;

  const order = GRADE_ORDER[rating.grade] ?? 0;
  const textColor = order >= 10 ? "text-emerald-500" : order >= 7 ? "text-blue-500" : order >= 4 ? "text-amber-500" : "text-red-500";

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-cyan-500">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bluechip Rating</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-bold font-mono tracking-tight ${textColor}`}>
          {rating.grade}
        </div>
        <p className="text-sm text-muted-foreground">
          {rating.collateralization}% collateralized
        </p>
        <a
          href={`${BLUECHIP_REPORT_BASE}/${rating.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
        >
          Full report <ExternalLink className="h-3 w-3" />
        </a>
      </CardContent>
    </Card>
  );
}

function LiquidityBox({ stablecoinId, liquidityMap }: { stablecoinId: string; liquidityMap: import("@/lib/types").DexLiquidityMap | undefined }) {
  const liq = liquidityMap?.[stablecoinId];
  if (!liq || (liq.liquidityScore === null && liq.poolCount === 0)) return null;

  const score = liq.liquidityScore ?? 0;
  const textColor = score >= 70 ? "text-emerald-500" : score >= 40 ? "text-amber-500" : "text-red-500";

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-cyan-500">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Liquidity Score</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-bold font-mono tracking-tight ${textColor}`}>
          {Math.round(score)}<span className="text-lg text-muted-foreground">/100</span>
        </div>
        <p className="text-sm text-muted-foreground font-mono">
          {formatCurrency(liq.totalTvlUsd)} TVL
        </p>
        <p className="text-sm text-muted-foreground">
          {liq.poolCount} pool{liq.poolCount !== 1 ? "s" : ""} &middot; {liq.chainCount} chain{liq.chainCount !== 1 ? "s" : ""}
        </p>
      </CardContent>
    </Card>
  );
}

function computePegScoreWithWindow(isNavToken: boolean, events: import("@/lib/types").DepegEvent[] | null, earliestTrackingDate: string | null) {
  if (isNavToken || !events) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const fourYearsAgo = nowSec - 4 * 365.25 * 86400;
  const rawTrackingStart = earliestTrackingDate ? Math.floor(Number(earliestTrackingDate)) : null;
  const trackingStartSec = rawTrackingStart != null
    ? Math.min(rawTrackingStart, fourYearsAgo)
    : fourYearsAgo;
  return computePegScore(events, trackingStartSec, nowSec);
}

export default function StablecoinDetailClient({ id }: { id: string }) {
  const { data: detailData, isLoading: detailLoading, isError: detailError } = useStablecoinDetail(id);
  const { data: listData, isLoading: listLoading, isError: listError } = useStablecoins();
  const { data: depegData } = useDepegEvents(id);
  const { data: ratingsMap } = useBluechipRatings();
  const { data: liquidityMap } = useDexLiquidity();
  const meta = findStablecoinMeta(id);
  const coinData: StablecoinData | undefined = listData?.peggedAssets?.find(
    (c: StablecoinData) => c.id === id
  );
  const isNavToken = meta?.flags.navToken ?? false;

  const isLoading = detailLoading || listLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  if (listError) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />Back to Dashboard</Link>
        </Button>
        <p className="text-muted-foreground">Signal lost. Try again shortly.</p>
      </div>
    );
  }

  if (!coinData) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />Back to Dashboard</Link>
        </Button>
        <p className="text-muted-foreground">This trail leads nowhere.</p>
      </div>
    );
  }

  const mcap = getCirculatingRaw(coinData);
  const price = coinData.price;
  const supply = (typeof price === "number" && price > 0) ? mcap / price : mcap;
  const prevDay = getPrevDayRaw(coinData);
  const prevWeek = getPrevWeekRaw(coinData);
  const prevMonth = getPrevMonthRaw(coinData);
  const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
  const pegRates = derivePegRates(listData?.peggedAssets ?? [], metaById, listData?.fxFallbackRates);
  const pegRef = getPegReference(coinData.pegType, pegRates, meta?.goldOunces);

  const chartHistory = detailData?.tokens ?? [];
  const earliestTrackingDate = chartHistory.length > 0 ? (chartHistory[0] as Record<string, unknown>).date as string : null;
  const pegScoreResult = computePegScoreWithWindow(isNavToken, depegData?.events ?? null, earliestTrackingDate);

  return (
    <div className="space-y-6">
      {detailError && (
        <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3 text-sm text-amber-600 dark:text-amber-400">
          Detailed chart data is temporarily unavailable. Showing summary data only.
        </div>
      )}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="rounded-2xl border-l-[3px] border-l-blue-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Price</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono tracking-tight">{formatNativePrice(coinData.price, meta?.flags.pegCurrency ?? "USD", pegRef)}</div>
            <p className="text-sm text-muted-foreground font-mono">{formatPegDeviation(coinData.price, pegRef)}</p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Market Cap</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono tracking-tight">{formatCurrency(mcap)}</div>
            <p className="text-sm text-muted-foreground">
              {coinData.chains?.length ?? 0} chains
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-l-[3px] border-l-blue-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Supply (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono tracking-tight">{formatSupply(supply)}</div>
            <p className={`text-sm font-mono ${mcap >= prevDay ? "text-green-500" : "text-red-500"}`}>
              {prevDay > 0 ? formatPercentChange(mcap, prevDay) : "N/A"}
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Supply Changes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">7d</span>
              <span className={`font-mono ${mcap >= prevWeek ? "text-green-500" : "text-red-500"}`}>
                {prevWeek > 0 ? formatPercentChange(mcap, prevWeek) : "N/A"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">30d</span>
              <span className={`font-mono ${mcap >= prevMonth ? "text-green-500" : "text-red-500"}`}>
                {prevMonth > 0 ? formatPercentChange(mcap, prevMonth) : "N/A"}
              </span>
            </div>
          </CardContent>
        </Card>

        {!isNavToken && (
          <Card className="rounded-2xl border-l-[3px] border-l-emerald-500">

            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Peg Score</CardTitle>
            </CardHeader>
            <CardContent>
              {pegScoreResult?.pegScore !== null && pegScoreResult?.pegScore !== undefined ? (
                <>
                  <div className={`text-3xl font-bold font-mono tracking-tight ${
                    pegScoreResult.pegScore >= 90
                      ? "text-emerald-500"
                      : pegScoreResult.pegScore >= 70
                        ? "text-amber-500"
                        : "text-red-500"
                  }`}>
                    {pegScoreResult.pegScore}<span className="text-lg text-muted-foreground">/100</span>
                  </div>
                  <p className="text-sm text-muted-foreground font-mono">
                    {pegScoreResult.pegPct.toFixed(1)}% at peg
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {pegScoreResult.eventCount} depeg event{pegScoreResult.eventCount !== 1 ? "s" : ""}
                  </p>
                </>
              ) : (
                <div className="text-3xl font-bold font-mono tracking-tight text-muted-foreground">N/A</div>
              )}
            </CardContent>
          </Card>
        )}

        <BluechipBox stablecoinId={id} ratingsMap={ratingsMap} />
        <LiquidityBox stablecoinId={id} liquidityMap={liquidityMap} />
      </div>

      <SupplyChart data={chartHistory} pegType={coinData.pegType} />


      {meta && (
        <MechanismCard meta={meta} />
      )}

      {meta && (
        <IssuerInfoCard meta={meta} />
      )}

      <DexLiquidityCard stablecoinId={id} />

      <DepegHistory stablecoinId={id} earliestTrackingDate={earliestTrackingDate} />

      <ChainDistribution coin={coinData} />
    </div>
  );
}
