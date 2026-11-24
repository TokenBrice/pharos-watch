"use client";

import Link from "next/link";
import { ArrowDownRight } from "lucide-react";
import { REDEMPTION_ACCESS_LABELS } from "@shared/lib/classification";
import { formatPercent } from "@shared/lib/format";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { RedemptionBackstopEntry, RedemptionHolderEligibility, RedemptionSettlementModel } from "@shared/types/redemption";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatHeroNativePrice } from "@/components/stablecoin-detail/hero-card-metrics";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-client-coin";
import type { DetailQuote } from "@/lib/stablecoin-detail-view-model-types";
import { normalizeWhitespace } from "@shared/lib/metadata-copy";
import { stripTermMarkup } from "@/lib/term-markup";

export interface TokenizedFundPanelProps {
  coin: StablecoinDetailCoinMeta;
  coinData: Pick<DetailQuote, "price" | "priceSource" | "priceObservedAtMode" | "nominalPriceReference">;
  pegRef: number | null;
  reserves: ReserveResult | null;
  redemptionBackstop: RedemptionBackstopEntry | null;
  hasReservesSection?: boolean;
  hasRedemptionSection?: boolean;
}

const HOLDER_ELIGIBILITY_LABELS: Record<RedemptionHolderEligibility, string> = {
  "any-holder": "Any holder",
  "verified-customer": "Verified customers (KYC / onboarding required)",
  "whitelisted-primary": "Whitelisted primary-market participants",
  "pre-incident-holder": "Pre-incident holders",
  "issuer-discretionary": "Issuer-discretionary eligibility",
  unknown: "Not documented in structured review",
};

const SETTLEMENT_LABELS: Record<RedemptionSettlementModel, string> = {
  atomic: "Atomic on-chain settlement",
  immediate: "Immediate settlement",
  "same-day": "Same-day settlement",
  days: "Multi-day settlement",
  queued: "Queued redemption processing",
};

const ELIGIBILITY_NOTICE_PATTERN = /eligib|qualif|kyc|whitelist|accredited|institutional|us person|restrict|permission|investor|reg\s*d/i;
const REDEMPTION_NOTICE_PATTERN = /redeem|redemption|cutoff|cut-off|settlement|queue|nav|suspend|minimum|subscribe|subscription|t\+\d/i;

function summarizeSentenceText(raw: string, maxLength = 220): string {
  const clean = normalizeWhitespace(stripTermMarkup(raw));
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength);
  const lastPeriod = cut.lastIndexOf(". ");
  if (lastPeriod >= 80) return cut.slice(0, lastPeriod + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function humanizePriceSource(source: string | null | undefined): string | null {
  if (!source) return null;
  const cleaned = source.trim();
  if (!cleaned) return null;
  const known: Record<string, string> = {
    coingecko: "CoinGecko",
    defillama: "DefiLlama",
    "defillama-list": "DefiLlama",
    "defillama-contract": "DefiLlama contract quote",
    "chainlink-nav": "Chainlink NAV oracle",
    "chronicle-nav": "Chronicle NAV oracle",
    "protocol-redeem": "Protocol redemption / NAV mark",
    "protocol-par": "Protocol par reference",
    redstone: "RedStone oracle",
    pyth: "Pyth oracle",
  };
  return known[cleaned] ?? cleaned.replace(/[-_]+/g, " ");
}

function buildHoldingsSummary(
  coin: StablecoinDetailCoinMeta,
  reserves: ReserveResult | null,
): { primary: string; detail: string | null } {
  const liveSlices = reserves?.reserves?.filter((slice) => slice.pct > 0) ?? [];
  const reviewedSlices = coin.reserveQualitySummary?.slices?.filter((slice) => slice.pct > 0) ?? [];
  const curatedSlices = coin.reserves?.filter((slice) => slice.pct > 0) ?? [];
  const slices = liveSlices.length > 0
    ? [...liveSlices].sort((left, right) => right.pct - left.pct)
    : reviewedSlices.length > 0
      ? [...reviewedSlices].sort((left, right) => right.pct - left.pct)
      : [...curatedSlices].sort((left, right) => right.pct - left.pct);

  const sourceDetail = coin.liveReservesConfig?.display?.label
    ?? (coin.proofOfReserves?.provider && coin.proofOfReserves.provider.length <= 72
      ? coin.proofOfReserves.provider
      : null);

  if (slices.length > 0) {
    const top = slices.slice(0, 3).map((slice) => `${formatPercent(slice.pct, slice.pct >= 10 ? 0 : 1)} ${slice.name}`);
    const rest = slices.length - top.length;
    const primary = rest > 0 ? `${top.join(" · ")} · +${rest} more` : top.join(" · ");
    return { primary, detail: sourceDetail };
  }

  if (coin.collateral) {
    return { primary: summarizeSentenceText(coin.collateral, 200), detail: sourceDetail };
  }

  return { primary: "Reserve holdings not structured yet.", detail: sourceDetail };
}

function buildNavPricingSummary(
  coin: StablecoinDetailCoinMeta,
  coinData: TokenizedFundPanelProps["coinData"],
  pegRef: number | null,
): { primary: string; detail: string | null } {
  const observed = isObservedPrice(coinData) && coinData.price != null;
  const priceLabel = observed
    ? formatHeroNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef, 4)
    : null;
  const basisLabel = coin.flags.navToken ? "NAV-accreting share token" : "Par-targeted fund share";
  const sourceLabel = humanizePriceSource(coinData.priceSource)
    ?? (coinData.nominalPriceReference ? humanizePriceSource(coinData.nominalPriceReference.source) : null)
    ?? coin.liveReservesConfig?.display?.label
    ?? null;

  if (priceLabel && sourceLabel) {
    return { primary: `${priceLabel} via ${sourceLabel}`, detail: basisLabel };
  }
  if (priceLabel) {
    return { primary: priceLabel, detail: basisLabel };
  }
  if (sourceLabel) {
    return { primary: `Price feed: ${sourceLabel}`, detail: `${basisLabel} · live quote unavailable` };
  }
  return { primary: basisLabel, detail: "Live price source unavailable" };
}

function buildRedemptionSummary(
  coin: StablecoinDetailCoinMeta,
  redemptionBackstop: RedemptionBackstopEntry | null,
): { primary: string; detail: string | null } {
  const structuredParts: string[] = [];
  if (redemptionBackstop) {
    structuredParts.push(REDEMPTION_ACCESS_LABELS[redemptionBackstop.accessModel]);
    structuredParts.push(SETTLEMENT_LABELS[redemptionBackstop.settlementModel]);
    if (redemptionBackstop.routeStatus === "suspended") {
      structuredParts.push("Route currently suspended");
    } else if (redemptionBackstop.feeDescription) {
      structuredParts.push(redemptionBackstop.feeDescription);
    } else if (redemptionBackstop.feeBps != null) {
      structuredParts.push(redemptionBackstop.feeBps === 0 ? "0% redemption fee" : `${(redemptionBackstop.feeBps / 100).toFixed(2)}% fee`);
    }
  }

  const redemptionNotice = (coin.notices ?? []).find((notice) =>
    REDEMPTION_NOTICE_PATTERN.test(`${notice.title} ${notice.message}`),
  );
  const pegMechanismSummary = coin.pegMechanism ? summarizeSentenceText(coin.pegMechanism, 220) : null;

  if (structuredParts.length > 0) {
    return {
      primary: structuredParts.join(" · "),
      detail: pegMechanismSummary ?? (redemptionNotice ? summarizeSentenceText(redemptionNotice.message, 180) : null),
    };
  }
  if (pegMechanismSummary) {
    return {
      primary: pegMechanismSummary,
      detail: redemptionNotice ? summarizeSentenceText(redemptionNotice.message, 180) : null,
    };
  }
  if (redemptionNotice) {
    return { primary: summarizeSentenceText(redemptionNotice.message, 220), detail: null };
  }
  return { primary: "Issuer redemption terms are not separately structured.", detail: null };
}

function buildEligibilitySummary(
  coin: StablecoinDetailCoinMeta,
  redemptionBackstop: RedemptionBackstopEntry | null,
): { primary: string; detail: string | null } {
  const jurisdictionParts = coin.jurisdiction
    ? [coin.jurisdiction.country, coin.jurisdiction.regulator, coin.jurisdiction.license].filter(Boolean)
    : [];
  const jurisdictionText = jurisdictionParts.length > 0 ? jurisdictionParts.join(" · ") : null;

  const eligibilityLabel = redemptionBackstop?.holderEligibility && redemptionBackstop.holderEligibility !== "unknown"
    ? HOLDER_ELIGIBILITY_LABELS[redemptionBackstop.holderEligibility]
    : null;

  const eligibilityNotice = (coin.notices ?? []).find((notice) =>
    ELIGIBILITY_NOTICE_PATTERN.test(`${notice.title} ${notice.message}`),
  );
  const noticeText = eligibilityNotice ? summarizeSentenceText(eligibilityNotice.message, 180) : null;

  if (eligibilityLabel && jurisdictionText) {
    return { primary: eligibilityLabel, detail: noticeText ? `${jurisdictionText} — ${noticeText}` : jurisdictionText };
  }
  if (jurisdictionText) {
    return { primary: jurisdictionText, detail: noticeText };
  }
  if (eligibilityLabel) {
    return { primary: eligibilityLabel, detail: noticeText };
  }
  if (noticeText) {
    return { primary: noticeText, detail: null };
  }
  return { primary: "Eligibility and jurisdiction disclosures are not structured yet.", detail: null };
}

export function TokenizedFundPanel({
  coin,
  coinData,
  pegRef,
  reserves,
  redemptionBackstop,
  hasReservesSection = false,
  hasRedemptionSection = false,
}: TokenizedFundPanelProps) {
  const holdings = buildHoldingsSummary(coin, reserves);
  const navPricing = buildNavPricingSummary(coin, coinData, pegRef);
  const redemption = buildRedemptionSummary(coin, redemptionBackstop);
  const eligibility = buildEligibilitySummary(coin, redemptionBackstop);

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS} data-tokenized-fund-panel="">
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>Tokenized fund</StablecoinModuleTitle>
        </div>
        <Badge
          variant="outline"
          className="shrink-0 rounded-full border-border/60 bg-muted/40 text-2xs font-medium text-muted-foreground"
        >
          Not graded
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col px-0 py-0">
        <div className="flex flex-1 flex-col space-y-4 px-4 py-5 sm:px-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Pharos does not grade fund shares on the stablecoin Safety Score scale. This fund stays tracked for reserve and downstream dependency transparency.
          </p>

          <dl className="divide-y divide-border/40 border-y border-border/40">
            <div className="py-3">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="pharos-label">Holdings &amp; reserves</dt>
                {hasReservesSection ? (
                  <Link
                    href="#reserves"
                    prefetch={false}
                    className="pharos-focus-ring inline-flex items-center gap-0.5 rounded-sm text-2xs font-medium text-brand-accent-text underline-offset-2 hover:underline"
                  >
                    <span>Full breakdown</span>
                    <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                ) : null}
              </div>
              <dd className="mt-1 text-sm font-medium leading-snug text-foreground">{holdings.primary}</dd>
              {holdings.detail ? (
                <dd className="mt-0.5 text-xs text-muted-foreground">{holdings.detail}</dd>
              ) : null}
            </div>

            <div className="py-3">
              <dt className="pharos-label">NAV &amp; price source</dt>
              <dd className="mt-1 text-sm font-medium leading-snug text-foreground">{navPricing.primary}</dd>
              {navPricing.detail ? (
                <dd className="mt-0.5 text-xs text-muted-foreground">{navPricing.detail}</dd>
              ) : null}
            </div>

            <div className="py-3">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="pharos-label">Redemption terms</dt>
                {hasRedemptionSection ? (
                  <Link
                    href="#redemption"
                    prefetch={false}
                    className="pharos-focus-ring inline-flex items-center gap-0.5 rounded-sm text-2xs font-medium text-brand-accent-text underline-offset-2 hover:underline"
                  >
                    <span>Route details</span>
                    <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                ) : null}
              </div>
              <dd className="mt-1 text-sm font-medium leading-snug text-foreground">{redemption.primary}</dd>
              {redemption.detail ? (
                <dd className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{redemption.detail}</dd>
              ) : null}
            </div>

            <div className="py-3">
              <dt className="pharos-label">Investor eligibility</dt>
              <dd className="mt-1 text-sm font-medium leading-snug text-foreground">{eligibility.primary}</dd>
              {eligibility.detail ? (
                <dd className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{eligibility.detail}</dd>
              ) : null}
            </div>
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}
