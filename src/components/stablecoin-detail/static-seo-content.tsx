import Link from "next/link";
import { IntentLink } from "@/components/intent-link";
import { Fragment, type ReactNode } from "react";
import { ArrowRight, Bell, Code2, Rss } from "lucide-react";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  getProfilePegLabel,
  getProofOfReservesStyle,
} from "@shared/lib/classification";
import { CHAIN_META } from "@shared/types/chain-identity";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
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
  StablecoinAiSummary,
  StablecoinMeta,
} from "@shared/types";
import {
  AI_SUMMARY_UNAVAILABLE_NOTICE,
  hasAvailableAiSummaryClaims,
  resolveAiSummaryClaims,
} from "@shared/lib/ai-summary-claims";
import { buildAiDisclosureLine, formatAiSummaryDate } from "@/components/ai-disclosure";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import { isBlacklistStablecoin } from "@shared/lib/blacklist";
import { buildStaticCompareHref } from "@/lib/compare-links";
import { buildContractDeploymentParts } from "@/lib/contract-deployment-summary";
import { PUBLIC_DATASET_CURRENT_DATE } from "@/lib/datasets/public-dataset-current";
import type { FaqItem } from "@/lib/faq";
import { normalizeWhitespace } from "@/lib/page-metadata";
import { getSnapshotSafetyAssessment, type SnapshotReleasePin } from "@/lib/safety-grade-snapshot";
import { getCurrentRedemptionConfig } from "@/lib/redemption-review-currency";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
  buildInfrastructureTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy-urls";
import { stripTermMarkup } from "@/lib/term-markup";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { getVariantAccessibleLabel, getVariantDisplay } from "@shared/lib/variant-display";
import { ListingStateBanner } from "@/components/stablecoin-detail/listing-state-banner";
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
const INLINE_LINK_CLASS = "pharos-focus-ring rounded-sm text-frost-blue underline-offset-2 hover:underline";

// Historical context from the existing USDC/SVB case study, not a live peg verdict.
const USDC_DEPEG_HISTORY_FAQ: FaqItem = {
  question: "Has USDC depegged?",
  answer:
    "Yes. USDC traded below its $1 target in March 2023 after Silicon Valley Bank failed and Circle disclosed reserve exposure to the bank. It recovered after authorities announced protection for SVB depositors. This historical recovery is not a guarantee of future peg stability.",
};

function summarizeText(text: string, maxLength = 280): string {
  const normalized = normalizeWhitespace(stripTermMarkup(text));
  if (normalized.length <= maxLength) return normalized;

  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(normalized)];
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

function formatJurisdiction(coin: StablecoinMeta): string {
  const jurisdiction = coin.jurisdiction;

  if (!jurisdiction) {
    return "Not disclosed in the static profile.";
  }

  return [jurisdiction.country, jurisdiction.regulator, jurisdiction.license].filter(Boolean).join(" / ");
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

  if (count === 0) {
    return <span>No contract deployments are listed in the static profile.</span>;
  }

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

function buildProfileSentence(coin: StablecoinMeta): string {
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = getProfilePegLabel(
    coin.flags,
    coin.pegReferenceId ? TRACKED_META_BY_ID.get(coin.pegReferenceId)?.symbol : undefined,
  );

  return `${coin.name} (${coin.symbol}) static profile: governance model ${governanceLabel}; backing model ${backingLabel}; peg ${pegLabel}.`;
}

function describeReserveEvidence(coin: StablecoinMeta): string {
  const proof = coin.proofOfReserves;
  if (proof) {
    const label = getProofOfReservesStyle(proof)?.label ?? proof.type.replace(/-/g, " ");
    return proof.provider ? `${label} from ${proof.provider}` : label;
  }
  if (coin.liveReservesConfig) {
    return "live reserve feed configured";
  }
  if (coin.reserves?.length) {
    return "curated reserve profile";
  }
  return "no linked reserve proof in the static profile";
}

function describeFreezeControl(coin: StablecoinMeta): string {
  const status = getResolvedBlacklistStatus(coin.id);

  switch (status) {
    case true:
      return "issuer or admin freeze controls are recorded";
    case "possible":
      return "admin controls such as a global pause or an upgradeable contract are recorded, but the review found no active power to freeze or seize a specific holder's balance on material deployments";
    case "inherited":
      return "freeze exposure is inherited through upstream collateral, custody, or wrapper dependencies";
    case false:
      return "no direct freeze-control path sets the verdict under the reviewed deployment-materiality scope";
    default:
      return "freeze-control coverage is not conclusive from static metadata alone";
  }
}

function buildSafetyAnswer(coin: StablecoinMeta, release?: SnapshotReleasePin): string {
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const reserveEvidence = describeReserveEvidence(coin);
  const freezeControl = describeFreezeControl(coin);

  if (coin.status === "frozen") {
    return `${coin.name} is a frozen Pharos archive, not a current safety endorsement. The archived static profile records a ${governanceLabel} governance model, ${backingLabel} backing, ${reserveEvidence}, and notes that ${freezeControl}.`;
  }

  if (coin.status === "quarantined" || coin.status === "delisted") {
    return `${coin.name} is not in Pharos's active universe. ${coin.listingStatusReview?.reason ?? "Its listing is retained only as a static catalog record."}`;
  }

  const asOf = formatIsoDayLabel(release?.snapshotDate ?? PUBLIC_DATASET_CURRENT_DATE);
  const coinFact = buildCoinSpecificRiskSentence(coin);
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

/** Build-time freeze-control fact, in plain English; null when coverage is inconclusive. */
function describeFreezeFact(coin: StablecoinMeta): string | null {
  switch (getResolvedBlacklistStatus(coin.id)) {
    case true:
      return "the issuer or an admin can freeze individual holders' balances";
    case "possible":
      return "admin controls such as a pause or an upgradeable contract exist, though no power to freeze a specific holder was found";
    case "inherited":
      return "freeze exposure is inherited through upstream collateral, custody or wrappers";
    case false:
      return "no direct power to freeze holders was found on its material deployments";
    default:
      return null;
  }
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
    describeFreezeFact(coin),
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
  const cost = config.costModel;
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

function buildBackingAnswer(coin: StablecoinMeta): string {
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const slices = (coin.reserves ?? []).filter((slice) => slice.pct > 0).sort((left, right) => right.pct - left.pct);
  const review = coin.reserveReview;
  let lead: string;
  if (slices.length > 0) {
    const listed = slices.slice(0, 3).map((slice) => `${formatPercent(slice.pct)} ${slice.name}`);
    const rest = slices.length - listed.length;
    const dated = review?.compositionAsOf
      ? ` as of ${formatIsoDayLabel(review.compositionAsOf)}`
      : review?.reviewedAt
        ? ` in its review of ${formatIsoDayLabel(review.reviewedAt)}`
        : "";
    const composition = formatProseList(
      rest > 0 ? [...listed, `${rest} smaller ${rest === 1 ? "holding" : "holdings"}`] : listed,
    );
    const recorder = coin.status === "frozen" ? "The archived Pharos profile records" : "Pharos records";
    lead = `${recorder} ${coin.symbol}'s reserves${dated} as ${composition}${composition.endsWith(".") ? "" : "."}`;
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
        ? `The static profile records its ${pegLabel} accounting mechanism as: ${summarizeText(coin.pegMechanism, 240)}`
        : `The static profile records its ${pegLabel} peg mechanism as: ${summarizeText(coin.pegMechanism, 240)}`
      : coin.flags.navToken
        ? `Its accounting reference is ${pegLabel}.`
        : `Its peg target is ${pegLabel}.`,
  ].join(" ");

  const redemptionAnswer = buildRedemptionAnswer(coin);

  const freezeAnswer = [
    `Based on tracked contract metadata and blacklist coverage, ${describeFreezeControl(coin)}.`,
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
    ...(coin.id === "usdc-circle" ? [USDC_DEPEG_HISTORY_FAQ] : []),
  ];
}

function ProofOfReservesValue({ coin }: { coin: StablecoinMeta }) {
  const proof = coin.proofOfReserves;

  if (!proof) {
    return <span>No proof-of-reserves entry in the static profile.</span>;
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
        className="pharos-focus-ring rounded-sm text-frost-blue underline-offset-2 hover:underline"
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

  return (
    <div className="mb-6 space-y-4">
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

      <ListingStateBanner coin={coin} />

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
        {coin.id === "usdc-circle" ? (
          <div className="mt-4 border-t border-border/50 pt-4">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">USDC depeg history</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{USDC_DEPEG_HISTORY_FAQ.answer}</p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
              <IntentLink href="/depeg/usdc-2023-03-11/" className={INLINE_LINK_CLASS}>
                March 2023 USDC depeg timeline
              </IntentLink>
              <IntentLink href="/learn/case-studies/usdc-svb-2023/" className={INLINE_LINK_CLASS}>
                Why USDC depegged during the SVB crisis
              </IntentLink>
            </div>
          </div>
        ) : null}
      </section>
      )}

      <section
        aria-labelledby="stablecoin-static-profile-title"
        className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5"
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
          <div className="space-y-3">
            <div>
              <p className="pharos-label mb-2">Profile</p>
              <h2 id="stablecoin-static-profile-title" className="text-lg font-semibold tracking-tight">
                {coin.symbol} profile facts
              </h2>
            </div>

            <p className="text-sm leading-relaxed text-muted-foreground">{buildProfileSentence(coin)}</p>

            <div className="flex flex-wrap gap-2" aria-label="Stablecoin taxonomy">
              <IntentLink
                href={buildGovernanceTaxonomyUrl(coin.flags.governance)}
                className={LINK_PILL_CLASS}
                aria-label={`Browse ${governanceLabel} stablecoins`}
              >
                {governanceLabel}
              </IntentLink>
              <IntentLink
                href={buildBackingTaxonomyUrl(coin.flags.backing)}
                className={LINK_PILL_CLASS}
                aria-label={`Browse ${backingLabel} stablecoins`}
              >
                {backingLabel}
              </IntentLink>
              {pegHref ? (
                <IntentLink href={pegHref} className={LINK_PILL_CLASS} aria-label={`Browse ${pegLabel} stablecoins`}>
                  {pegLabel}
                </IntentLink>
              ) : (
                <span className={STATIC_PILL_CLASS}>{pegLabel}</span>
              )}
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
            </div>

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
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-1">
            <div>
              <dt className={FACT_LABEL_CLASS}>Collateral</dt>
              <dd className={FACT_VALUE_CLASS}>{coin.collateral ?? "Not specified in the static profile."}</dd>
            </div>
            <div>
              <dt className={FACT_LABEL_CLASS}>Peg mechanism</dt>
              <dd className={FACT_VALUE_CLASS}>{coin.pegMechanism ?? "Not specified in the static profile."}</dd>
            </div>
            <div>
              <dt className={FACT_LABEL_CLASS}>Jurisdiction</dt>
              <dd className={FACT_VALUE_CLASS}>{formatJurisdiction(coin)}</dd>
            </div>
            <div>
              <dt className={FACT_LABEL_CLASS}>Proof of reserves</dt>
              <dd className={FACT_VALUE_CLASS}>
                <ProofOfReservesValue coin={coin} />
              </dd>
            </div>
            <div>
              <dt className={FACT_LABEL_CLASS}>Contracts</dt>
              <dd className={FACT_VALUE_CLASS}>
                <ContractSummary coin={coin} />
              </dd>
            </div>
            {coin.identifiers?.isin ? (
              <div>
                <dt className={FACT_LABEL_CLASS}>ISIN</dt>
                <dd className={FACT_VALUE_CLASS}>{coin.identifiers.isin.join(", ")}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        {afterDossier ? null : (
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
        )}

        <p className="mt-4 border-t border-border/50 pt-3 text-xs leading-relaxed text-muted-foreground">
          Source: Pharos registry profile fields.
          {isActiveStablecoinMeta(coin)
            ? " Live price, supply, reserve, liquidity, event, and safety data load in the interactive dossier on this page"
            : " This inactive record does not participate in current live monitoring"}
          {summaryUpdatedAt ? `; the summary above was last updated ${summaryUpdatedAt}` : ""}.
        </p>
      </section>
    </div>
  );
}
