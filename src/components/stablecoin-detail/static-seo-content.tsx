import Link from "next/link";
import { IntentLink } from "@/components/intent-link";
import { Fragment, type ReactNode } from "react";
import { ArrowRight, Bell, ChevronDown, Code2, Rss } from "lucide-react";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  getProfilePegLabel,
  getProofOfReservesStyle,
} from "@shared/lib/classification";
import { CHAIN_META } from "@shared/types/chain-identity";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isTokenizedFundId } from "@shared/lib/stablecoins/listing-governance";
import { getReserves } from "@shared/lib/reserve-templates";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import { formatProseList, formatUtcDayLabel } from "@shared/lib/format";
import {
  resolveDefaultHolderEligibility,
  resolveReviewedRedemptionSettlement,
  type RedemptionBackstopConfig,
} from "@shared/lib/redemption-backstop-configs/shared";
import type {
  RedemptionHolderEligibility,
  RedemptionSettlementModel,
} from "@shared/types/redemption";
import type {
  StablecoinAiSummary,
} from "@shared/types/editorial";
import type {
  StablecoinMeta,
} from "@shared/types/stablecoin-meta-schemas";
import {
  AI_SUMMARY_UNAVAILABLE_NOTICE,
  hasAvailableAiSummaryClaims,
  resolveAiSummaryClaims,
} from "@shared/lib/ai-summary-claims";
import { buildAiDisclosureLine, formatAiSummaryDate } from "@/components/ai-summary/ai-disclosure";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import { buildFreezeControlDescriptor, describeFreezeControl } from "@/lib/stablecoin-detail-blacklistability-client";
import { isBlacklistStablecoin } from "@shared/lib/blacklist";
import { buildStaticCompareHref } from "@/lib/compare-links";
import { buildContractDeploymentParts } from "@/lib/contract-deployment-summary";
import { PUBLIC_DATASET_CURRENT_DATE } from "@/lib/datasets/public-dataset-current";
import type { FaqItem } from "@/lib/faq";
import { normalizeWhitespace } from "@/lib/page-metadata";
import { getSnapshotSafetyAssessment, type SnapshotReleasePin } from "@/lib/safety-grade-snapshot";
import { getCurrentRedemptionConfig } from "@/lib/redemption-review-currency";
import { STABLECOIN_HISTORICAL_CONTEXT } from "@/lib/stablecoin-detail-historical-context";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
  buildInfrastructureTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy-urls";
import { stripTermMarkup } from "@/lib/term-markup";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { getVariantAccessibleLabel, getVariantDisplay } from "@shared/lib/variant-display";
import { ListingStateBanner, type ActivePeerOfframp } from "@/components/stablecoin-detail/listing-state-banner";
import {
  getDisplayedVariantSiblings,
  SameTickerStablecoins,
} from "@/components/stablecoin-detail/same-ticker-stablecoins";

interface StablecoinDetailSeoContentProps {
  coin: StablecoinMeta;
  includeHeading?: boolean;
  /** Rendered after the dossier: skip the blocks the dossier and the FAQ below already carry. */
  afterDossier?: boolean;
  summary?: StablecoinAiSummary | null;
  /** Active cohort peers surfaced as an off-ramp on quarantined profiles. */
  activePeers?: readonly ActivePeerOfframp[];
  logos?: Record<string, string>;
}

const LINK_PILL_CLASS =
  "pharos-focus-ring inline-flex min-h-9 items-center rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground";
const STATIC_PILL_CLASS =
  "inline-flex min-h-9 items-center rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground";
const ACTION_LINK_CLASS =
  "pharos-focus-ring inline-flex min-h-10 items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-foreground/30 hover:bg-accent";

const FACT_LABEL_CLASS = "pharos-label";
const FACT_VALUE_CLASS = "mt-1 text-sm leading-relaxed text-foreground";
const ACTION_ICON_CLASS = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
const INLINE_LINK_CLASS = "pharos-focus-ring rounded-sm text-brand-accent-text underline-offset-2 hover:underline";

const EN_SENTENCE_SEGMENTER = new Intl.Segmenter("en", { granularity: "sentence" });

function summarizeText(text: string, maxLength = 280): string {
  const normalized = normalizeWhitespace(stripTermMarkup(text));
  if (normalized.length <= maxLength) return normalized;

  const sentences = [...EN_SENTENCE_SEGMENTER.segment(normalized)];
  let complete = "";
  for (const { segment } of sentences) {
    const candidate = `${complete}${segment}`;
    if (candidate.trimEnd().length > maxLength) break;
    complete = candidate;
  }
  // A single long sentence is preferable to a fragment that can drop a
  // redemption restriction or other qualification.
  return complete.trimEnd() || sentences[0]!.segment.trim();
}

function formatJurisdiction(coin: StablecoinMeta): string | null {
  const jurisdiction = coin.jurisdiction;
  if (!jurisdiction) return null;
  return [jurisdiction.country, jurisdiction.regulator, jurisdiction.license].filter(Boolean).join(" / ") || null;
}

function renderInlineList(items: readonly ReactNode[]): ReactNode {
  return items.map((item, index) => (
    <Fragment key={index}>
      {index > 0 ? (index === items.length - 1 ? (items.length === 2 ? " and " : ", and ") : ", ") : null}
      {item}
    </Fragment>
  ));
}

function ContractSummary({ coin }: { coin: StablecoinMeta }) {
  const { count, sample, chainNames, remaining: remainingCount, deploymentLabel } = buildContractDeploymentParts(
    coin.contracts,
  );

  const sampleChains = sample.map((contract, index) => {
    const meta = CHAIN_META[contract.chain];
    const label = chainNames[index];

    if (!meta) {
      return <span key={`${contract.chain}-${contract.address}`}>{label}</span>;
    }

    return (
      <Link
        key={`${contract.chain}-${contract.address}`}
        href={`/chains/${contract.chain}/`}
        className={INLINE_LINK_CLASS}
        aria-label={`View ${label} chain profile`}
      >
        {label}
      </Link>
    );
  });
  const remaining = remainingCount > 0 ? `, plus ${remainingCount} more` : "";

  return (
    <span>
      {count} {deploymentLabel} tracked across {renderInlineList(sampleChains)}
      {remaining}.
    </span>
  );
}

function VariantRelationshipSummary({ coin }: { coin: StablecoinMeta }) {
  if (!coin.variantOf || !coin.variantKind) return null;

  const parent = TRACKED_META_BY_ID.get(coin.variantOf);
  if (!parent) return null;

  const display = getVariantDisplay(coin.variantKind);
  const variantLabel = getVariantAccessibleLabel(coin.variantKind).toLowerCase();
  const siblings = getDisplayedVariantSiblings(coin);

  return (
    <div className="pharos-inset px-3 py-3">
      <p className="pharos-label">Variant relationship</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {coin.name} ({coin.symbol}) is modeled as a {variantLabel} of{" "}
        <Link
          href={buildStablecoinUrl(parent.id)}
          className={INLINE_LINK_CLASS}
          aria-label={`View ${parent.name} (${parent.symbol}) parent asset`}
        >
          {parent.name} ({parent.symbol})
        </Link>
        . Pharos treats parent stress, redemption, mint authority, and dependency context as relevant to this variant
        before interpreting its own live metrics.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <span
          className={`inline-flex min-h-8 items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${display.badgeClass}`}
        >
          {display.fullLabel}
        </span>
        {siblings.map((sibling) => (
          <Link
            key={sibling.id}
            href={buildStablecoinUrl(sibling.id)}
            className={LINK_PILL_CLASS}
            aria-label={`View related ${sibling.name} (${sibling.symbol}) variant`}
          >
            {sibling.name} ({sibling.symbol})
          </Link>
        ))}
      </div>
    </div>
  );
}

function describeReserveEvidence(coin: StablecoinMeta): string {
  const proof = coin.proofOfReserves;
  if (proof) {
    const label = getProofOfReservesStyle(proof)?.label ?? proof.type.replace(/-/g, " ");
    return proof.provider ? `${label} from ${proof.provider}` : label;
  }
  if (coin.liveReservesConfig) {
    return "a live reserve feed";
  }
  if (coin.id === "msusd-metronome" && coin.reserveReview?.knownUnknownExposurePct === 100) {
    return "reviewed collateral eligibility with no verified msUSD allocation";
  }
  if (coin.id === "dusd-alto" && coin.reserveReview?.scope === "selected-slices") {
    return "a nominal issuance estimate based on mint-market debt and the USM's frxUSD balance";
  }
  if (coin.reserveReview?.scope === "selected-slices") {
    if (coin.reserveReview.knownUnknownExposurePct === 100) return "a reserve review with unresolved allocation";
    return coin.reserveReview.scopedWeights ? "a scoped reserve report" : "a review of selected holdings";
  }
  if (coin.reserves?.length) {
    return "a reviewed reserve composition";
  }
  return "no proof-of-reserves report listed";
}

function buildSafetyAnswer(coin: StablecoinMeta, release?: SnapshotReleasePin): string {
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const reserveEvidence = describeReserveEvidence(coin);
  const freezeControl = describeFreezeControl(buildFreezeControlDescriptor(coin, getResolvedBlacklistStatus(coin.id))).sentence;

  if (coin.status === "frozen") {
    return `${coin.name} is a frozen Pharos archive, not a current safety endorsement. The archived profile records a ${governanceLabel} governance model, ${backingLabel} backing, ${reserveEvidence}, and notes that ${freezeControl}.`;
  }

  if (coin.status === "quarantined" || coin.status === "delisted") {
    return `${coin.name} is not in Pharos's active universe. ${coin.listingStatusReview?.reason ?? "Its listing is retained only as a static catalog record."}`;
  }

  const coinFact = buildCoinSpecificRiskSentence(coin);

  if (isTokenizedFundId(coin.id)) {
    return `Pharos tracks ${coin.name} (${coin.symbol}) as a tokenized fund for reserve and dependency transparency and does not assign fund shares a stablecoin Safety Score letter grade. ${coinFact} See the Tokenized fund panel on this page for holdings, NAV pricing, redemption terms, and investor eligibility.`;
  }

  const asOf = formatIsoDayLabel(release?.snapshotDate ?? PUBLIC_DATASET_CURRENT_DATE);
  const liveRead =
    "The grade moves as reserve, redemption, peg and control evidence changes; the live Safety Score on this page shows the current reading.";

  const assessment = release ? (release.assessments[coin.id] ?? null) : getSnapshotSafetyAssessment(coin.id);
  if (!assessment) {
    return `As of ${asOf}, Pharos had not published a Safety Score grade for ${coin.symbol}, so this answer makes no overall safety call. ${coinFact} The live Safety Score on this page shows a grade once one is published.`;
  }

  const gradeClause = assessment.score !== null
    ? `${assessment.grade} (${assessment.score}/100)`
    : assessment.grade;
  const tierSentence = {
    safe: "That grade is in the Score's upper band, which does not rule out losses.",
    neutral: "That is a middle-band grade: it meets baseline expectations but carries meaningful weaknesses.",
    risky: "That is a low-band grade, which flags significant structural risk.",
  }[assessment.bucket];

  return `As of ${asOf}, Pharos grades ${coin.symbol} ${gradeClause} on its Safety Score. ${coinFact} ${tierSentence} ${liveRead}`;
}

function formatIsoDayLabel(isoDate: string): string {
  return formatUtcDayLabel(new Date(`${isoDate}T00:00:00Z`));
}

const REDEMPTION_ELIGIBILITY_SUBJECTS: Record<RedemptionHolderEligibility, string | null> = {
  "any-holder": "any holder",
  "verified-customer": "customers the issuer has verified",
  "whitelisted-primary": "whitelisted primary-market participants",
  "pre-incident-holder": "holders from before a recorded incident",
  "issuer-discretionary": "holders the issuer accepts case by case",
  unknown: null,
};

function getRedemptionEligibility(config: RedemptionBackstopConfig): RedemptionHolderEligibility {
  return config.holderEligibility ?? resolveDefaultHolderEligibility(config);
}

function describeRedemptionFact(config: RedemptionBackstopConfig): string | null {
  if (config.routeStatus === "suspended") return "its reviewed redemption route is suspended";
  const eligibility = getRedemptionEligibility(config);
  switch (eligibility) {
    case "any-holder":
      return "any holder can use its reviewed redemption route";
    case "unknown":
      return null;
    default:
      return `direct redemption is limited to ${REDEMPTION_ELIGIBILITY_SUBJECTS[eligibility]}`;
  }
}

/**
 * One coin-specific sentence from build-time evidence. The release's scores
 * mirror carries no pillar breakdown, so this names recorded freeze controls
 * and redemption eligibility, falling back to the backing classification.
 */
function buildCoinSpecificRiskSentence(coin: StablecoinMeta): string {
  const redemptionConfig = getCurrentRedemptionConfig(coin.id);
  const facts = [
    describeFreezeControl(buildFreezeControlDescriptor(coin, getResolvedBlacklistStatus(coin.id))).compact,
    redemptionConfig ? describeRedemptionFact(redemptionConfig) : null,
  ].filter((fact): fact is string => fact !== null);
  if (facts.length === 0) {
    const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
    return `Pharos classifies its backing as ${backingLabel}, with ${describeReserveEvidence(coin)}.`;
  }
  return `Pharos's reviews record that ${facts.join(", and ")}.`;
}

function formatBpsAsPercent(bps: number): string {
  return `${Number((bps / 100).toFixed(3))}%`;
}

function describeRedemptionFee(config: RedemptionBackstopConfig): string | null {
  // The v9 route terms carry extra terms of the same reviewed schedule.
  const cost = { ...config.costModel, ...config.v9RouteCostTerms };
  const min = cost.kind === "fee-bps" ? cost.feeBps : cost.feeBpsMin;
  const max = cost.feeBpsMax ?? (cost.kind === "fee-bps" ? cost.feeBps : undefined);
  const suffix = config.outputAssetType === "physical-commodity-delivery" ? ", before delivery and third-party costs" : "";
  if (max === 0) return `The reviewed terms charge no percentage redemption fee${suffix}.`;
  if (max !== undefined && (min === undefined || min === max)) {
    return min === undefined
      ? `The reviewed redemption fee is at most ${formatBpsAsPercent(max)}${suffix}.`
      : `The reviewed redemption fee is ${formatBpsAsPercent(max)}${suffix}.`;
  }
  if (max !== undefined && min !== undefined) {
    return `The reviewed redemption fee ranges from ${formatBpsAsPercent(min)} to ${formatBpsAsPercent(max)}${suffix}.`;
  }
  // A minimum alone is a floor, never evidence of the payable maximum.
  if (min !== undefined) return `The reviewed redemption fee is at least ${formatBpsAsPercent(min)}${suffix}.`;
  return "The fee is variable or not fully published.";
}

const REDEMPTION_SETTLEMENT_SENTENCES: Record<RedemptionSettlementModel, string> = {
  atomic: "Redemption settles atomically on-chain.",
  immediate: "Settlement is immediate.",
  "same-day": "Settlement is same-day.",
  days: "Settlement takes multiple days.",
  queued: "Requests go through a redemption queue.",
};

function formatTokenAmount(value: number): string {
  return value.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

function formatUsdAmount(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function describeRedemptionOutput(coin: StablecoinMeta, config: RedemptionBackstopConfig): string {
  const physical = config.physicalCommodityDelivery;
  const minimum = physical
    ? `, starting at ${formatTokenAmount(physical.minimumDeliveryTokens)} ${coin.symbol}`
    : config.v9RouteReviewTerms?.minRedeemUsd
      ? `, with a ${formatUsdAmount(config.v9RouteReviewTerms.minRedeemUsd)} minimum`
      : "";
  const outputSymbols = config.outputAssets?.map((asset) =>
    asset.startsWith("asset:") ? asset.slice("asset:".length).toUpperCase() : TRACKED_META_BY_ID.get(asset)?.symbol,
  );
  if (outputSymbols?.every((symbol): symbol is string => Boolean(symbol))) {
    const listed = outputSymbols.slice(0, 3);
    const rest = outputSymbols.length - listed.length;
    return `for ${formatProseList(rest > 0 ? [...listed, `${rest} other assets`] : listed)}${minimum}`;
  }
  // A reviewed fiat payout is a known identity; only an output the review
  // could not identify stays unresolved.
  const hasUnresolvedIdentity = config.unresolvedOutputAssetKeys?.some((key) => !key.startsWith("fiat:"));
  if (hasUnresolvedIdentity) {
    return `for an unresolved output asset${minimum}`;
  }
  switch (config.outputAssetType) {
    case "stable-single":
      return `for a single stable asset, such as cash or a stablecoin${minimum}`;
    case "stable-basket":
      return `for a basket of stable assets${minimum}`;
    case "bluechip-collateral":
      return `for blue-chip crypto collateral${minimum}`;
    case "physical-commodity-delivery":
      return `for physical metal${minimum}`;
    case "mixed-collateral":
      return `for a mix of collateral assets${minimum}`;
    case "nav":
      return `at its net asset value${minimum}`;
  }
}

/**
 * "How do you redeem X?" from the reviewed redemption route. Null without a
 * current review; the answer never implies that the reader qualifies.
 */
function buildRedemptionAnswer(coin: StablecoinMeta): string | null {
  if (!isActiveStablecoinMeta(coin)) return null;
  const config = getCurrentRedemptionConfig(coin.id);
  if (!config?.reviewedAt) return null;
  const reviewed = formatIsoDayLabel(config.reviewedAt);
  const output = describeRedemptionOutput(coin, config);
  const subject = REDEMPTION_ELIGIBILITY_SUBJECTS[getRedemptionEligibility(config)];
  return [
    subject
      ? `Under the route Pharos reviewed on ${reviewed}, ${subject} can redeem ${coin.symbol} ${output}.`
      : `Under the route Pharos reviewed on ${reviewed}, ${coin.symbol} redeems ${output}; holder eligibility is not documented.`,
    config.routeStatus === "suspended" ? "Pharos records this route as suspended." : null,
    REDEMPTION_SETTLEMENT_SENTENCES[resolveReviewedRedemptionSettlement(config)],
    describeRedemptionFee(config),
    "Whether a given holder qualifies is set by the route's own terms, not by this summary.",
  ]
    .filter(Boolean)
    .join(" ");
}

function formatPercent(value: number): string {
  return value < 0.1 ? "under 0.1%" : `${Number(value.toFixed(1))}%`;
}

/** What a scoped report's shares are measured against, per reviewed composition basis. */
const SCOPED_RESERVE_DENOMINATORS: Record<string, string> = {
  "nusd-nexus": "nominal pool balances",
  "satusd-river": "gross product deposits",
  "xo-exodus": "measured holdings in scope",
};

function buildBackingAnswer(coin: StablecoinMeta): string {
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const review = coin.reserveReview;
  const issuancePaths = coin.id === "dusd-alto" && review?.scope === "selected-slices";
  const holdingsOnly = review?.scope === "selected-slices" && !review.scopedWeights && !issuancePaths;
  const hasEvidenceGap = holdingsOnly && (review.knownUnknownExposurePct === 100
    || review.nonLinkDispositions?.some((row) => row.disposition === "insufficient-evidence"));
  const slices = (coin.reserves?.length ? getReserves(coin)!.reserves : []).filter((slice) => slice.pct > 0);
  if (!holdingsOnly) slices.sort((left, right) => right.pct - left.pct);
  let lead: string;
  if (slices.length > 0) {
    const listed = (issuancePaths ? slices : slices.slice(0, 3))
      .map((slice) => holdingsOnly ? slice.name : `${formatPercent(slice.pct)} ${slice.name}`);
    const rest = slices.length - listed.length;
    const dated = review?.compositionAsOf
      ? ` as of ${formatIsoDayLabel(review.compositionAsOf)}`
      : review?.reviewedAt
        ? ` in its review of ${formatIsoDayLabel(review.reviewedAt)}`
        : "";
    const remainder = hasEvidenceGap ? (rest === 1 ? "other entry" : "other entries")
      : `${holdingsOnly ? "other" : "smaller"} ${rest === 1 ? "holding" : "holdings"}`;
    const composition = formatProseList(rest > 0 ? [...listed, `${rest} ${remainder}`] : listed);
    const recorder = coin.status === "frozen" ? "The archived Pharos profile records" : "Pharos records";
    const subject = issuancePaths ? `these shares of ${coin.symbol}'s reviewed nominal issuance paths`
      : hasEvidenceGap ? `${coin.symbol}'s reserve review findings`
      : holdingsOnly ? `${coin.symbol}'s identified holdings`
      : review?.scope === "selected-slices"
        ? SCOPED_RESERVE_DENOMINATORS[coin.id]
          ? `these shares of ${SCOPED_RESERVE_DENOMINATORS[coin.id]} for ${coin.symbol}`
          : `these shares of ${coin.symbol}'s scoped reserve report`
        : `${coin.symbol}'s reserves`;
    lead = `${recorder} ${subject}${dated} as ${composition}${composition.endsWith(".") ? "" : "."}`;
  } else if (coin.collateral) {
    lead = `${coin.symbol}'s collateral, per its Pharos profile: ${summarizeText(coin.collateral, 240)}`;
  } else {
    lead = `Pharos has no reserve composition on file for ${coin.symbol}.`;
  }

  const proof = coin.proofOfReserves;
  const proofLabel = getProofOfReservesStyle(proof)?.label ?? proof?.type.replace(/-/g, " ") ?? null;
  // Some provider fields carry review prose rather than a name; only short names read as an attestor.
  const attestor = proof?.provider && proof.provider.length <= 80 && !/\.\s/.test(proof.provider) ? proof.provider : null;
  const periodEnd = proof?.latestReport?.periodEnd;
  const evidence = proofLabel
    ? `Reserve evidence: ${proofLabel}${attestor ? ` by ${attestor}` : ""}${
        periodEnd ? `, latest period ending ${formatIsoDayLabel(periodEnd)}` : ""
      }.`
    : `Reserve evidence: ${describeReserveEvidence(coin)}.`;

  return [lead, evidence, `Pharos classifies the backing as ${backingLabel}.`].join(" ");
}

function buildAlertCommand(coin: StablecoinMeta): string {
  if (isTokenizedFundId(coin.id)) {
    return coin.flags.navToken ? `/subscribe dews ${coin.id}` : `/subscribe dews,depeg ${coin.id}`;
  }
  return `/subscribe dews,depeg,safety ${coin.id}`;
}

/**
 * Data-derived Q&A for AI-search citation on the coin long tail. Every answer
 * is assembled from checked-in data — StablecoinMeta fields, reviewed historical context,
 * reviewed redemption routes, plus the scores-latest dataset mirror (refreshed from the
 * live API at each Pages release) for the dated safety grade. No editorial claims beyond
 * those sources.
 */
export function buildStablecoinFaqItems(coin: StablecoinMeta, release?: SnapshotReleasePin): FaqItem[] {
  const pegLabel = getProfilePegLabel(
    coin.flags,
    coin.pegReferenceId ? TRACKED_META_BY_ID.get(coin.pegReferenceId)?.symbol : undefined,
  );
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;

  const identityAnswer = [
    coin.oneLiner
      ? normalizeWhitespace(stripTermMarkup(coin.oneLiner))
      : coin.flags.navToken
        ? `${coin.name} (${coin.symbol}) is a ${backingLabel} yield-bearing token with ${pegLabel} and a ${governanceLabel} governance model.`
        : `${coin.name} (${coin.symbol}) is a ${backingLabel} stablecoin tracking ${pegLabel}, with a ${governanceLabel} governance model.`,
    coin.pegMechanism
      ? coin.flags.navToken
        ? `Pharos records its ${pegLabel} accounting mechanism as: ${summarizeText(coin.pegMechanism, 240)}`
        : `Pharos records its ${pegLabel} peg mechanism as: ${summarizeText(coin.pegMechanism, 240)}`
      : coin.flags.navToken
        ? `Its accounting reference is ${pegLabel}.`
        : `Its peg target is ${pegLabel}.`,
  ].join(" ");

  const redemptionAnswer = buildRedemptionAnswer(coin);
  const historicalContext = STABLECOIN_HISTORICAL_CONTEXT[coin.id];

  const freezeAnswer = [
    `Based on tracked contract metadata and blacklist coverage, ${describeFreezeControl(buildFreezeControlDescriptor(coin, getResolvedBlacklistStatus(coin.id))).sentence}.`,
    coin.status === "frozen"
      ? `${coin.symbol} is a frozen Pharos archive; the recorded history below is read-only.`
      : isActiveStablecoinMeta(coin)
        ? isBlacklistStablecoin(coin.symbol.toUpperCase())
          ? `Live freeze and blacklist events for ${coin.symbol}, when applicable, appear in the live dossier on this page.`
          : null
        : `${coin.symbol} is outside active monitoring; this static record preserves the reviewed control context.`,
  ]
    .filter(Boolean)
    .join(" ");

  const identityQuestion =
    coin.name.trim().toLowerCase() === coin.symbol.trim().toLowerCase()
      ? `What is ${coin.symbol}?`
      : `What is ${coin.name} (${coin.symbol})?`;

  return [
    { question: identityQuestion, answer: /[.!?]$/.test(identityAnswer) ? identityAnswer : `${identityAnswer}.` },
    { question: `Is ${coin.symbol} safe?`, answer: buildSafetyAnswer(coin, release) },
    { question: `What backs ${coin.symbol}?`, answer: buildBackingAnswer(coin) },
    { question: `Can ${coin.symbol} be frozen or blacklisted?`, answer: freezeAnswer },
    ...(redemptionAnswer ? [{ question: `How do you redeem ${coin.symbol}?`, answer: redemptionAnswer }] : []),
    ...(historicalContext ? [historicalContext.faq] : []),
  ];
}

/**
 * Never asserts an absence the live dossier contradicts: a coin without a
 * report but with live or reviewed reserve evidence says so and points at the
 * Reserves module; only a coin with none of the three reads "none listed".
 */
function ProofOfReservesValue({ coin, linkReserves }: { coin: StablecoinMeta; linkReserves: boolean }) {
  const proof = coin.proofOfReserves;

  if (!proof) {
    if (!coin.liveReservesConfig && !coin.reserves?.length) return <span>No proof-of-reserves report listed.</span>;
    return (
      <span>
        {`No attestation report listed; Pharos tracks ${describeReserveEvidence(coin)}`}
        {linkReserves ? (
          <>
            {" "}in{" "}
            <a href="#reserves" className={INLINE_LINK_CLASS}>
              Reserves
            </a>
          </>
        ) : null}
        .
      </span>
    );
  }

  const style = getProofOfReservesStyle(proof);
  const label = style?.label ?? proof.type.replace(/-/g, " ");
  const providerText = proof.provider ? `${label} by ${proof.provider}` : label;

  return (
    <span>
      {providerText}{" "}
      <a
        href={proof.url}
        target="_blank"
        rel="noopener noreferrer"
        className="pharos-focus-ring rounded-sm text-brand-accent-text underline-offset-2 hover:underline"
      >
        Reserve source
      </a>
    </span>
  );
}

export function StablecoinDetailSeoContent({
  coin,
  includeHeading = true,
  afterDossier = false,
  summary = null,
  activePeers,
  logos,
}: StablecoinDetailSeoContentProps) {
  const pegHref = buildPegLandingUrl(coin.flags.pegCurrency);
  const pegLabel = getProfilePegLabel(
    coin.flags,
    coin.pegReferenceId ? TRACKED_META_BY_ID.get(coin.pegReferenceId)?.symbol : undefined,
  );
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const summaryUpdatedAt = summary?.updatedAt ? formatAiSummaryDate(summary.updatedAt) : null;
  // Live claims are withheld until the interactive dossier has their inputs.
  const summaryText = summary
    ? hasAvailableAiSummaryClaims(summary.text, summary.claimTokens)
      ? resolveAiSummaryClaims(summary.text, summary.claimTokens).text
      : AI_SUMMARY_UNAVAILABLE_NOTICE
    : null;
  const compareHref = buildStaticCompareHref([coin.id]);
  const alertCommand = buildAlertCommand(coin);
  const [identityAnswer, safetyAnswer] = buildStablecoinFaqItems(coin);
  const historicalContext = STABLECOIN_HISTORICAL_CONTEXT[coin.id];
  const jurisdiction = formatJurisdiction(coin);
  const hasContracts = (coin.contracts?.length ?? 0) > 0;
  const active = isActiveStablecoinMeta(coin);

  // Below the dossier the folded profile is one more module in the page's
  // run, so its title takes the module scale ("Explore next" above it), not
  // the pre-hydration card's section scale.
  const profileHeading = (
    <h2
      id="stablecoin-static-profile-title"
      className={afterDossier ? DETAIL_MODULE_TITLE_CLASS : "text-lg font-semibold tracking-tight text-foreground"}
    >
      About {coin.symbol}
    </h2>
  );
  // Facts the record actually carries; a missing field is omitted rather than
  // printed as "not specified".
  const profileBody = (
    <div className="space-y-4">
      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4" aria-label="Stablecoin taxonomy">
        <div>
          <dt className={FACT_LABEL_CLASS}>Governance</dt>
          <dd className="mt-1">
            <IntentLink
              href={buildGovernanceTaxonomyUrl(coin.flags.governance)}
              className={LINK_PILL_CLASS}
              aria-label={`Browse ${governanceLabel} stablecoins`}
            >
              {governanceLabel}
            </IntentLink>
          </dd>
        </div>
        <div>
          <dt className={FACT_LABEL_CLASS}>Backing</dt>
          <dd className="mt-1">
            <IntentLink
              href={buildBackingTaxonomyUrl(coin.flags.backing)}
              className={LINK_PILL_CLASS}
              aria-label={`Browse ${backingLabel} stablecoins`}
            >
              {backingLabel}
            </IntentLink>
          </dd>
        </div>
        <div>
          <dt className={FACT_LABEL_CLASS}>{coin.flags.navToken ? "Denomination" : "Peg"}</dt>
          <dd className="mt-1">
            {pegHref ? (
              <IntentLink href={pegHref} className={LINK_PILL_CLASS} aria-label={`Browse ${pegLabel} stablecoins`}>
                {pegLabel}
              </IntentLink>
            ) : (
              <span className={STATIC_PILL_CLASS}>{pegLabel}</span>
            )}
          </dd>
        </div>
        {(coin.infrastructures ?? []).length > 0 ? (
          <div>
            <dt className={FACT_LABEL_CLASS}>Infrastructure</dt>
            <dd className="mt-1 flex flex-wrap gap-2">
              {(coin.infrastructures ?? []).map((infrastructure) => (
                <IntentLink
                  key={infrastructure}
                  href={buildInfrastructureTaxonomyUrl(infrastructure)}
                  className={LINK_PILL_CLASS}
                  aria-label={`Browse ${getInfrastructureLabel(infrastructure)} infrastructure stablecoins`}
                >
                  {getInfrastructureLabel(infrastructure)}
                </IntentLink>
              ))}
            </dd>
          </div>
        ) : null}
        {coin.collateral ? (
          <div className="col-span-full">
            <dt className={FACT_LABEL_CLASS}>Collateral</dt>
            <dd className={FACT_VALUE_CLASS}>{coin.collateral}</dd>
          </div>
        ) : null}
        {coin.pegMechanism ? (
          <div className="col-span-full">
            <dt className={FACT_LABEL_CLASS}>{coin.flags.navToken ? "Accounting mechanism" : "Peg mechanism"}</dt>
            <dd className={FACT_VALUE_CLASS}>{coin.pegMechanism}</dd>
          </div>
        ) : null}
        {jurisdiction ? (
          <div>
            <dt className={FACT_LABEL_CLASS}>Jurisdiction</dt>
            <dd className={FACT_VALUE_CLASS}>{jurisdiction}</dd>
          </div>
        ) : null}
        <div>
          <dt className={FACT_LABEL_CLASS}>Proof of reserves</dt>
          <dd className={FACT_VALUE_CLASS}>
            <ProofOfReservesValue coin={coin} linkReserves={afterDossier && active} />
          </dd>
        </div>
        {hasContracts ? (
          <div>
            <dt className={FACT_LABEL_CLASS}>Contracts</dt>
            <dd className={FACT_VALUE_CLASS}>
              <ContractSummary coin={coin} />
            </dd>
          </div>
        ) : null}
        {coin.identifiers?.isin ? (
          <div>
            <dt className={FACT_LABEL_CLASS}>ISIN</dt>
            <dd className={FACT_VALUE_CLASS}>{coin.identifiers.isin.join(", ")}</dd>
          </div>
        ) : null}
      </dl>

      <VariantRelationshipSummary coin={coin} />

      <SameTickerStablecoins coin={coin} />

      {summary ? (
        <div className="pharos-inset px-3 py-2.5">
          <p className="pharos-label">
            AI summary{summaryUpdatedAt ? ` / Updated ${summaryUpdatedAt}` : ""}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-foreground">{summarizeText(summaryText ?? "", 520)}</p>
          {(() => {
            const disclosure = buildAiDisclosureLine(summary);
            return disclosure ? (
              <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">{disclosure}</p>
            ) : null;
          })()}
        </div>
      ) : null}

      <p className="border-t border-border/50 pt-3 text-xs leading-relaxed text-muted-foreground">
        From Pharos&apos;s reviewed coin profile.
        {active
          ? afterDossier
            ? " Live price, supply, reserve, liquidity and safety data are in the dossier above"
            : " Live price, supply, reserve, liquidity and safety data load in the dossier on this page"
          : " This inactive record is not part of current live monitoring"}
        {summaryUpdatedAt ? `; the summary above was last updated ${summaryUpdatedAt}` : ""}.
      </p>
    </div>
  );

  return (
    <div className={afterDossier ? "mb-2 space-y-4" : "mb-6 space-y-4"}>
      {includeHeading ? (
        <h1 className="sr-only">
          {coin.status === "frozen"
            ? `${coin.name} (${coin.symbol}) frozen stablecoin archive`
            : coin.status === "delisted"
              ? `${coin.name} (${coin.symbol}) delisted stablecoin record`
              : coin.status === "quarantined"
                ? `${coin.name} (${coin.symbol}) quarantined stablecoin record`
                : `${coin.name} (${coin.symbol}) stablecoin analytics`}
        </h1>
      ) : null}

      <ListingStateBanner coin={coin} activePeers={activePeers} logos={logos} />

      {afterDossier ? null : (
      <section aria-labelledby="stablecoin-identity-answer-title" className="pharos-card-shell px-4 py-4 sm:px-5">
        <p className="pharos-label mb-2">Answer first</p>
        <h2 id="stablecoin-identity-answer-title" className="text-lg font-semibold tracking-tight text-foreground">
          {identityAnswer.question}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{identityAnswer.answer}</p>
        <div className="mt-4 border-t border-border/50 pt-4">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{safetyAnswer.question}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{safetyAnswer.answer}</p>
        </div>
        {historicalContext ? (
          <div className="mt-4 border-t border-border/50 pt-4">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">{historicalContext.profileHeading}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{historicalContext.faq.answer}</p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
              {historicalContext.references.map((reference) => (
                <IntentLink key={reference.url} href={reference.url} className={INLINE_LINK_CLASS}>
                  {reference.label}
                </IntentLink>
              ))}
            </div>
          </div>
        ) : null}
      </section>
      )}

      {afterDossier ? (
        // Below the dossier the profile repeats what the modules show live, so
        // it folds closed; the facts stay in the server HTML for crawlers.
        <section aria-labelledby="stablecoin-static-profile-title" className="border-t border-border/50 pt-4">
          <details className="group/about">
            <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg py-1 sm:min-h-9 [&::-webkit-details-marker]:hidden">
              {profileHeading}
              <span className="hidden text-sm text-muted-foreground sm:inline">Classification, backing and deployments</span>
              <ChevronDown
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open/about:rotate-180 motion-reduce:transition-none"
              />
            </summary>
            <div className="mt-3">{profileBody}</div>
          </details>
        </section>
      ) : (
        <section aria-labelledby="stablecoin-static-profile-title" className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5">
          {profileHeading}
          <div className="mt-3">{profileBody}</div>
          <div className="mt-4 border-t border-border/50 pt-4">
            <div className="pharos-inset px-3 py-3">
              <p className="pharos-label">Next actions</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {isActiveStablecoinMeta(coin) ? (
                  <IntentLink href={compareHref} className={ACTION_LINK_CLASS}>
                    <ArrowRight aria-hidden="true" className={ACTION_ICON_CLASS} />
                    Compare {coin.symbol}
                  </IntentLink>
                ) : null}
                {isActiveStablecoinMeta(coin) ? (
                  <IntentLink href="/pharoswatchbot/#getting-started" className={ACTION_LINK_CLASS}>
                    <Bell aria-hidden="true" className={ACTION_ICON_CLASS} />
                    Telegram alerts
                  </IntentLink>
                ) : null}
                <a href="/feed/digest.xml" className={ACTION_LINK_CLASS}>
                  <Rss aria-hidden="true" className={ACTION_ICON_CLASS} />
                  Digest RSS
                </a>
                <IntentLink href="/api/" className={ACTION_LINK_CLASS}>
                  <Code2 aria-hidden="true" className={ACTION_ICON_CLASS} />
                  API access
                </IntentLink>
              </div>
              {isActiveStablecoinMeta(coin) ? (
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Alert command:{" "}
                  <code className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-2xs text-foreground">
                    {alertCommand}
                  </code>
                </p>
              ) : (
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  This record preserves static and historical context; live actions are available only for active assets.
                </p>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
