import Link from "next/link";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
  POR_BADGE_STYLES,
} from "@shared/lib/classification";
import { CHAIN_META } from "@shared/lib/chains";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import type { StablecoinAiSummary, StablecoinMeta } from "@shared/types";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
  buildInfrastructureTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy";

interface StablecoinDetailSeoContentProps {
  coin: StablecoinMeta;
  summary?: StablecoinAiSummary | null;
}

const LINK_PILL_CLASS =
  "pharos-focus-ring inline-flex min-h-9 items-center rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground";
const STATIC_PILL_CLASS =
  "inline-flex min-h-9 items-center rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground";

const FACT_LABEL_CLASS = "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground";
const FACT_VALUE_CLASS = "mt-1 text-sm leading-relaxed text-foreground";

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function summarizeText(text: string, maxLength = 280): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return normalized;

  const truncated = normalized.slice(0, maxLength - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  const wordBoundary = lastSpace > Math.floor(maxLength * 0.7) ? lastSpace : truncated.length;

  return `${truncated.slice(0, wordBoundary).replace(/[,.!?;:]+$/, "")}...`;
}

function formatDateLabel(rawDate: string): string {
  const match = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return rawDate;
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatJurisdiction(coin: StablecoinMeta): string {
  const jurisdiction = coin.jurisdiction;

  if (!jurisdiction) {
    return "Not disclosed in the static profile.";
  }

  return [jurisdiction.country, jurisdiction.regulator, jurisdiction.license].filter(Boolean).join(" / ");
}

function buildContractSummary(coin: StablecoinMeta): string {
  const contracts = coin.contracts ?? [];

  if (contracts.length === 0) {
    return "No contract deployments are listed in the static profile.";
  }

  const sampleChains = contracts.slice(0, 4).map((contract) => CHAIN_META[contract.chain]?.name ?? contract.chain);
  const remainingCount = Math.max(contracts.length - sampleChains.length, 0);
  const remaining = remainingCount > 0 ? `, plus ${remainingCount} more` : "";
  const deploymentLabel = contracts.length === 1 ? "deployment" : "deployments";

  return `${contracts.length} ${deploymentLabel} tracked across ${formatList(sampleChains)}${remaining}.`;
}

function buildProfileSentence(coin: StablecoinMeta): string {
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;

  return `${coin.name} (${coin.symbol}) static profile: governance model ${governanceLabel}; backing model ${backingLabel}; peg ${pegLabel}.`;
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
  const summaryUpdatedAt = summary?.updatedAt ? formatDateLabel(summary.updatedAt) : null;

  return (
    <div className="mb-6 space-y-4">
      <h1 className="sr-only">
        {coin.status === "frozen"
          ? `${coin.name} (${coin.symbol}) frozen stablecoin archive`
          : `${coin.name} (${coin.symbol}) stablecoin analytics`}
      </h1>

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

            <p className="text-sm leading-relaxed text-muted-foreground">
              {buildProfileSentence(coin)}
            </p>

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

            {summary ? (
              <div className="rounded-lg border border-border/50 bg-background/50 px-3 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  AI summary{summaryUpdatedAt ? ` / Updated ${summaryUpdatedAt}` : ""}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-foreground">
                  {summarizeText(summary.text)}
                </p>
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
              <dd className={FACT_VALUE_CLASS}>{buildContractSummary(coin)}</dd>
            </div>
          </dl>
        </div>

        <p className="mt-4 border-t border-border/50 pt-3 text-xs leading-relaxed text-muted-foreground">
          Source: checked-in StablecoinMeta profile fields. Live price, supply, reserve, liquidity, event, and safety
          data load in the interactive dossier below
          {summaryUpdatedAt ? `; the summary above was last updated ${summaryUpdatedAt}` : ""}.
        </p>
      </section>
    </div>
  );
}
