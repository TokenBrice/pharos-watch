import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { ArrowRight, Bell, Code2, Rss } from "lucide-react";
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT, POR_BADGE_STYLES } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/lib/chains";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import type { StablecoinAiSummary, StablecoinMeta } from "@shared/types";
import { buildAiDisclosureLine, formatAiSummaryDate } from "@/components/ai-disclosure";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { buildLiveCompareUrl, getPrimaryStaticComparisonLinkForCoin } from "@/lib/compare-links";
import { buildContractDeploymentParts } from "@/lib/contract-deployment-summary";
import type { FaqItem } from "@/lib/faq";
import { normalizeWhitespace } from "@/lib/page-metadata";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
  buildInfrastructureTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy-urls";
import { stripTermMarkup } from "@/lib/term-markup";
import { buildStablecoinUrl } from "@/lib/urls";
import { getVariantAccessibleLabel, getVariantDisplay } from "@shared/lib/variant-display";
import { ListingStateBanner } from "@/components/stablecoin-detail/listing-state-banner";

interface StablecoinDetailSeoContentProps {
  coin: StablecoinMeta;
  summary?: StablecoinAiSummary | null;
}

const LINK_PILL_CLASS =
  "pharos-focus-ring inline-flex min-h-9 items-center rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground";
const STATIC_PILL_CLASS =
  "inline-flex min-h-9 items-center rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground";
const ACTION_LINK_CLASS =
  "pharos-focus-ring inline-flex min-h-10 items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-foreground/30 hover:bg-accent";

const FACT_LABEL_CLASS = "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground";
const FACT_VALUE_CLASS = "mt-1 text-sm leading-relaxed text-foreground";
const ACTION_ICON_CLASS = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
const INLINE_LINK_CLASS = "pharos-focus-ring rounded-sm text-frost-blue underline-offset-2 hover:underline";

function summarizeText(text: string, maxLength = 280): string {
  const normalized = normalizeWhitespace(stripTermMarkup(text));
  if (normalized.length <= maxLength) return normalized;

  const truncated = normalized.slice(0, maxLength - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  const wordBoundary = lastSpace > Math.floor(maxLength * 0.7) ? lastSpace : truncated.length;

  return `${truncated.slice(0, wordBoundary).replace(/[,.!?;:]+$/, "")}...`;
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
  const siblings = TRACKED_STABLECOINS.filter(
    (candidate) =>
      candidate.variantOf === parent.id &&
      candidate.id !== coin.id &&
      isActiveStablecoinMeta(candidate),
  ).slice(0, 4);

  return (
    <div className="rounded-lg border border-border/50 bg-background/50 px-3 py-3">
      <p className="pharos-kicker">Variant Relationship</p>
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
            {sibling.symbol}
          </Link>
        ))}
      </div>
    </div>
  );
}

function buildProfileSentence(coin: StablecoinMeta): string {
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;

  return `${coin.name} (${coin.symbol}) static profile: governance model ${governanceLabel}; backing model ${backingLabel}; peg ${pegLabel}.`;
}

function describeReserveEvidence(coin: StablecoinMeta): string {
  const proof = coin.proofOfReserves;
  if (proof?.provider) {
    const style = POR_BADGE_STYLES[proof.type];
    const label = style?.label ?? proof.type.replace(/-/g, " ");
    return `${label} from ${proof.provider}`;
  }
  if (proof) {
    const style = POR_BADGE_STYLES[proof.type];
    return style?.label ?? proof.type.replace(/-/g, " ");
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
      return "freeze or administrative control exposure is possible but not fully confirmed";
    case "inherited":
      return "freeze exposure is inherited through upstream collateral, custody, or wrapper dependencies";
    case false:
      return "no direct freeze-control signal is recorded";
    default:
      return "freeze-control coverage is not conclusive from static metadata alone";
  }
}

function buildSafetyAnswer(coin: StablecoinMeta): string {
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

  return `Pharos does not mark ${coin.symbol} as absolutely safe. Static metadata says ${coin.name} uses a ${governanceLabel} governance model and ${backingLabel} backing, with ${reserveEvidence}; the main caveat is that ${freezeControl}. Treat the live peg, liquidity, reserve, dependency, and Safety Score sections below as the current risk read.`;
}

function buildAlertCommand(coin: StablecoinMeta): string {
  return `/subscribe dews,depeg,safety ${coin.id}`;
}

/**
 * Data-derived Q&A for AI-search citation on the coin long tail. Every answer
 * is assembled verbatim from checked-in StablecoinMeta fields — no live data,
 * no editorial claims beyond the static profile.
 */
export function buildStablecoinFaqItems(coin: StablecoinMeta): FaqItem[] {
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;

  const identityAnswer = [
    coin.oneLiner
      ? normalizeWhitespace(stripTermMarkup(coin.oneLiner))
      : `${coin.name} (${coin.symbol}) is a ${backingLabel} stablecoin tracking ${pegLabel}, with a ${governanceLabel} governance model.`,
    coin.pegMechanism
      ? `The static profile records its ${pegLabel} peg mechanism as: ${summarizeText(coin.pegMechanism, 240)}`
      : `Its peg target is ${pegLabel}.`,
  ].join(" ");

  const backingAnswer = [
    `Pharos classifies ${coin.symbol} backing as ${backingLabel}.`,
    coin.collateral ? `Collateral, per the static profile: ${summarizeText(coin.collateral, 240)}` : null,
    `Reserve evidence: ${describeReserveEvidence(coin)}.`,
  ]
    .filter(Boolean)
    .join(" ");

  const freezeAnswer = [
    `Based on tracked contract metadata and blacklist coverage, ${describeFreezeControl(coin)}.`,
    coin.status === "frozen"
      ? `${coin.symbol} is a frozen Pharos archive; the recorded history below is read-only.`
      : isActiveStablecoinMeta(coin)
        ? `Live freeze and blacklist events for ${coin.symbol}, when applicable, appear in the dossier below.`
        : `${coin.symbol} is outside active monitoring; this static record preserves the reviewed control context.`,
  ].join(" ");

  const identityQuestion =
    coin.name.trim().toLowerCase() === coin.symbol.trim().toLowerCase()
      ? `What is ${coin.symbol}?`
      : `What is ${coin.name} (${coin.symbol})?`;

  return [
    { question: identityQuestion, answer: identityAnswer },
    { question: `Is ${coin.symbol} safe?`, answer: buildSafetyAnswer(coin) },
    { question: `What backs ${coin.symbol}?`, answer: backingAnswer },
    { question: `Can ${coin.symbol} be frozen or blacklisted?`, answer: freezeAnswer },
  ];
}

function ProofOfReservesValue({ coin }: { coin: StablecoinMeta }) {
  const proof = coin.proofOfReserves;

  if (!proof) {
    return <span>No proof-of-reserves entry in the static profile.</span>;
  }

  const style = POR_BADGE_STYLES[proof.type];
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

export function StablecoinDetailSeoContent({ coin, summary = null }: StablecoinDetailSeoContentProps) {
  const pegHref = buildPegLandingUrl(coin.flags.pegCurrency);
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const summaryUpdatedAt = summary?.updatedAt ? formatAiSummaryDate(summary.updatedAt) : null;
  const compareHref = getPrimaryStaticComparisonLinkForCoin(coin.id)?.href ?? buildLiveCompareUrl([coin.id]);
  const alertCommand = buildAlertCommand(coin);

  return (
    <div className="mb-6 space-y-4">
      <h1 className="sr-only">
        {coin.status === "frozen"
          ? `${coin.name} (${coin.symbol}) frozen stablecoin archive`
          : coin.status === "delisted"
            ? `${coin.name} (${coin.symbol}) delisted stablecoin record`
            : coin.status === "quarantined"
              ? `${coin.name} (${coin.symbol}) quarantined stablecoin record`
              : `${coin.name} (${coin.symbol}) stablecoin analytics`}
      </h1>

      <ListingStateBanner coin={coin} />

      {coin.oneLiner ? <p className="text-base italic leading-relaxed text-muted-foreground">{coin.oneLiner}</p> : null}

      <section
        aria-labelledby="stablecoin-static-profile-title"
        className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5"
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
          <div className="space-y-3">
            <div>
              <p className="pharos-kicker mb-2">Static Profile</p>
              <h2 id="stablecoin-static-profile-title" className="text-lg font-semibold tracking-tight">
                Static stablecoin profile
              </h2>
            </div>

            <p className="text-sm leading-relaxed text-muted-foreground">{buildProfileSentence(coin)}</p>

            <div className="flex flex-wrap gap-2" aria-label="Stablecoin taxonomy">
              <Link
                href={buildGovernanceTaxonomyUrl(coin.flags.governance)}
                className={LINK_PILL_CLASS}
                aria-label={`Browse ${governanceLabel} stablecoins`}
              >
                {governanceLabel}
              </Link>
              <Link
                href={buildBackingTaxonomyUrl(coin.flags.backing)}
                className={LINK_PILL_CLASS}
                aria-label={`Browse ${backingLabel} stablecoins`}
              >
                {backingLabel}
              </Link>
              {pegHref ? (
                <Link href={pegHref} className={LINK_PILL_CLASS} aria-label={`Browse ${pegLabel} stablecoins`}>
                  {pegLabel}
                </Link>
              ) : (
                <span className={STATIC_PILL_CLASS}>{pegLabel}</span>
              )}
              {(coin.infrastructures ?? []).map((infrastructure) => (
                <Link
                  key={infrastructure}
                  href={buildInfrastructureTaxonomyUrl(infrastructure)}
                  className={LINK_PILL_CLASS}
                  aria-label={`Browse ${getInfrastructureLabel(infrastructure)} infrastructure stablecoins`}
                >
                  {getInfrastructureLabel(infrastructure)}
                </Link>
              ))}
            </div>

            <VariantRelationshipSummary coin={coin} />

            {summary ? (
              <div className="rounded-lg border border-border/50 bg-background/50 px-3 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  AI summary{summaryUpdatedAt ? ` / Updated ${summaryUpdatedAt}` : ""}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-foreground">{summarizeText(summary.text)}</p>
                {(() => {
                  const disclosure = buildAiDisclosureLine(summary);
                  return disclosure ? (
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{disclosure}</p>
                  ) : null;
                })()}
                {summary.sources?.length ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    Sources: {renderInlineList(summary.sources.map((source) => (
                      <Link key={source.url} href={source.url} className={INLINE_LINK_CLASS}>
                        {source.label}
                      </Link>
                    )))}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-1">
            <div>
              <dt className={FACT_LABEL_CLASS}>Collateral</dt>
              <dd className={FACT_VALUE_CLASS}>{coin.collateral ?? "Not specified in the static profile."}</dd>
            </div>
            <div>
              <dt className={FACT_LABEL_CLASS}>Peg Mechanism</dt>
              <dd className={FACT_VALUE_CLASS}>{coin.pegMechanism ?? "Not specified in the static profile."}</dd>
            </div>
            <div>
              <dt className={FACT_LABEL_CLASS}>Jurisdiction</dt>
              <dd className={FACT_VALUE_CLASS}>{formatJurisdiction(coin)}</dd>
            </div>
            <div>
              <dt className={FACT_LABEL_CLASS}>Proof Of Reserves</dt>
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
          </dl>
        </div>

        <div className="mt-4 grid gap-3 border-t border-border/50 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.72fr)]">
          <div className="rounded-lg border border-border/50 bg-background/50 px-3 py-3">
            <p className="pharos-kicker">Snippet Answer</p>
            <h3 className="mt-1 text-base font-semibold tracking-tight text-foreground">Is {coin.symbol} safe?</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{buildSafetyAnswer(coin)}</p>
          </div>

          <div className="rounded-lg border border-border/50 bg-background/50 px-3 py-3">
            <p className="pharos-kicker">Next Actions</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {isActiveStablecoinMeta(coin) ? (
                <Link href={compareHref} className={ACTION_LINK_CLASS}>
                  <ArrowRight aria-hidden="true" className={ACTION_ICON_CLASS} />
                  Compare {coin.symbol}
                </Link>
              ) : null}
              {isActiveStablecoinMeta(coin) ? (
                <Link href="/pharoswatchbot/#getting-started" className={ACTION_LINK_CLASS}>
                  <Bell aria-hidden="true" className={ACTION_ICON_CLASS} />
                  Telegram alerts
                </Link>
              ) : null}
              <Link href="/feed/digest.xml" className={ACTION_LINK_CLASS}>
                <Rss aria-hidden="true" className={ACTION_ICON_CLASS} />
                Digest RSS
              </Link>
              <Link href="/api/" className={ACTION_LINK_CLASS}>
                <Code2 aria-hidden="true" className={ACTION_ICON_CLASS} />
                API access
              </Link>
            </div>
            {isActiveStablecoinMeta(coin) ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Exact bot target:{" "}
                <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
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

        <p className="mt-4 border-t border-border/50 pt-3 text-xs leading-relaxed text-muted-foreground">
          Source: checked-in StablecoinMeta profile fields.
          {isActiveStablecoinMeta(coin)
            ? " Live price, supply, reserve, liquidity, event, and safety data load in the interactive dossier below"
            : " This inactive record does not participate in current live monitoring"}
          {summaryUpdatedAt ? `; the summary above was last updated ${summaryUpdatedAt}` : ""}.
        </p>
      </section>
    </div>
  );
}
