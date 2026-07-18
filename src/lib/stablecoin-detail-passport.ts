import type { MechanismArchetype, RedemptionBackstopEntry, StablecoinMeta } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type { BlacklistStatus } from "@shared/lib/report-cards";
import {
  BACKING_BADGE_STYLES,
  MECHANISM_ARCHETYPE_SHORT_LABELS,
  POR_BADGE_STYLES,
  POR_TIER_STYLES,
} from "@shared/lib/classification";
import { GENIUS_REGIME_STATE } from "@shared/lib/compliance-regime-state";
import { GENIUS_STATUS_SHORT_LABELS, GENIUS_STATUS_TEXT_CLS } from "@shared/lib/genius";
import { MICA_STATUS_BADGE_STYLES } from "@shared/lib/mica";
import { REDEMPTION_ACCESS_LABELS, REDEMPTION_ACCESS_PASSPORT_LABELS } from "@shared/lib/redemption-backstop-scoring";
import { buildCoinTrackerLink } from "@/lib/coin-tracker-links";
import { HERO_MUTED_CLASS } from "@/lib/stablecoin-detail-hero-metrics";

export interface HeroPassportItemViewModel {
  key:
    | "mechanism"
    | "attestor"
    | "jurisdiction"
    | "issued"
    | "mica"
    | "genius"
    | "redeemability"
    | "minting"
    | "freeze"
    | "record"
    | "chains";
  category:
    | "Mechanism"
    | "Attestor"
    | "Jurisdiction"
    | "Issued"
    | "MiCA"
    | "GENIUS"
    | "Redeemability"
    | "Minting"
    | "Freeze"
    | "Record"
    | "Chains";
  /** Authored-short value from a bounded vocabulary — never CSS-truncated. */
  value: string;
  href: string;
  /** Text tone on the value for data-driven states (freeze, attestor tier). */
  valueClass?: string;
  ariaLabel: string;
  /** Hover detail lines (Figma coin template: jurisdiction authority stack). */
  tooltipLines?: string[];
  /** Render the value inside a pill chip (Figma coin template: chain count). */
  chip?: boolean;
}

/** Structural slice of MintAuthorityDetailViewModel the passport needs. */
export interface PassportMintAuthorityInput {
  status: "reviewed" | "not-reviewed";
  mintPathLabel: string;
  /** Passport-short projection of the mint path (strip width budget); the aria-label keeps the full label. */
  mintPathShortLabel: string;
}

/** Structural slice of PegSummaryCoin the passport record entry needs. */
export interface PassportPegRecordInput {
  eventCount: number;
  depegEventCoverageLimited?: boolean;
}

/**
 * Loose-validates the curated ISO `launchDate` (a population sweep is filling
 * it coin-by-coin, so absence is normal) and formats it as a long-form UTC
 * date, e.g. "September 26, 2018". Returns null for absent or malformed
 * values. Also backs the Key Information card's `Launched` proof line.
 */
export function formatLaunchDate(launchDate: string | undefined): string | null {
  if (!launchDate || !/^\d{4}-\d{2}-\d{2}$/.test(launchDate)) return null;
  const parsed = new Date(`${launchDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Same data-driven freeze tones as the retired identity FreezablePill — amber
// for any freeze surface, emerald only for a reviewed clear status. Text-only:
// passport entries are flat document fields, not tinted pills.
const FREEZE_TONE_RESTRICTED = "text-amber-700 dark:text-amber-400";
const FREEZE_TONE_CLEAR = "text-emerald-700 dark:text-emerald-400";

// A clean peg record earns the same emerald as a reviewed clear freeze status;
// a non-zero count stays default foreground — it is history, not an alarm.

// Passport-short country forms (Figma coin template shows "USA" + tooltip).
// Only unambiguous common abbreviations — everything else keeps the curated
// country name; the authority stack lives in the tooltip and aria-label.
const COUNTRY_PASSPORT_CODES: Record<string, string> = {
  "United States": "USA",
  "United Kingdom": "UK",
  "United Arab Emirates": "UAE",
  "British Virgin Islands": "BVI",
};

// Passport-short attestor tiers (Figma: "NICHE"); full labels stay in the
// aria-label and the Key Information card.
const ATTESTOR_PASSPORT_LABELS: Record<keyof typeof POR_TIER_STYLES, string> = {
  big4: "Big-4",
  regional: "Regional CPA",
  niche: "Niche",
  self: "Self-attested",
  none: "None",
};

function buildFreezePassportItem(
  coin: StablecoinMeta,
  blacklistStatus: BlacklistStatus | null,
  mintAuthorityReviewed: boolean,
): HeroPassportItemViewModel {
  // Target priority: live blacklist tracker > mint-authority evidence >
  // FreezeWatch coverage page (coins without an in-page freeze section).
  const href = (BLACKLIST_STABLECOINS as readonly string[]).includes(coin.symbol)
    ? "#blacklist"
    : mintAuthorityReviewed
      ? "#mint-authority"
      : buildCoinTrackerLink(coin.id, "freezewatch", coin.symbol).href;

  switch (blacklistStatus) {
    case true:
      return {
        key: "freeze",
        category: "Freeze",
        value: "Yes",
        href,
        valueClass: FREEZE_TONE_RESTRICTED,
        ariaLabel: "Freezable — issuer can freeze, block, or seize balances",
      };
    case "possible":
      return {
        key: "freeze",
        category: "Freeze",
        value: "Possible",
        href,
        valueClass: FREEZE_TONE_RESTRICTED,
        ariaLabel:
          "Possible freeze — admin surfaces could enable freezing but no active address-level freezing is confirmed",
      };
    case "inherited":
      return {
        key: "freeze",
        category: "Freeze",
        value: "Upstream",
        href,
        valueClass: FREEZE_TONE_RESTRICTED,
        ariaLabel: "Upstream freeze — freezing is inherited from an upstream issuer or collateral asset",
      };
    default:
      return {
        key: "freeze",
        category: "Freeze",
        value: "No",
        href,
        valueClass: FREEZE_TONE_CLEAR,
        ariaLabel: "Unfreezable — no issuer-level freeze, block, or seize capability",
      };
  }
}

/**
 * The hero "passport" row: the verification facts as document-style anchor
 * entries, scanned in two clusters — how the token works (mechanism,
 * redeemability, minting, freeze powers, peg track record, chain count), then
 * who stands behind it (jurisdiction, MiCA/GENIUS regulatory visas, attestor,
 * launch date). Entries whose dedicated proof block does not render fall
 * back to `#info`; the attestor entry is omitted entirely for decentralized
 * coins (mirroring the Key Information card's skip), and every other
 * conditional entry is omitted when its dataset has no record for the coin —
 * honest emptiness over faked fields.
 */
export function buildHeroPassportItems({
  coin,
  chainCount,
  blacklistStatus,
  resolvedMechanismArchetype,
  mintAuthority,
  redemptionBackstop,
  pegScoreResult,
  isNavToken,
}: {
  coin: StablecoinMeta;
  chainCount: number;
  blacklistStatus: BlacklistStatus | null;
  resolvedMechanismArchetype: MechanismArchetype | null;
  mintAuthority: PassportMintAuthorityInput;
  redemptionBackstop: RedemptionBackstopEntry | null;
  pegScoreResult: PassportPegRecordInput | null;
  isNavToken: boolean;
}): HeroPassportItemViewModel[] {
  const isDecentralized = coin.flags.governance === "decentralized";
  const hasMechanismBlock = Boolean(coin.collateral || coin.pegMechanism);
  const mintAuthorityReviewed = mintAuthority.status === "reviewed";
  const mechanismValue = resolvedMechanismArchetype
    ? MECHANISM_ARCHETYPE_SHORT_LABELS[resolvedMechanismArchetype]
    : (BACKING_BADGE_STYLES[coin.flags.backing]?.label ?? coin.flags.backing);
  const jurisdictionCountry = coin.jurisdiction?.country ?? null;

  // Cluster 1 — how the token works: mechanism, exit path, supply controls,
  // freeze powers, track record, footprint.
  const items: HeroPassportItemViewModel[] = [
    {
      key: "mechanism",
      category: "Mechanism",
      value: mechanismValue,
      href: hasMechanismBlock ? "#mechanism" : "#info",
      ariaLabel: `Peg mechanism: ${mechanismValue} — jump to Key Information`,
    },
  ];

  if (redemptionBackstop) {
    const accessLabel = REDEMPTION_ACCESS_LABELS[redemptionBackstop.accessModel];
    items.push({
      key: "redeemability",
      category: "Redeemability",
      value: REDEMPTION_ACCESS_PASSPORT_LABELS[redemptionBackstop.accessModel],
      href: "#redemption",
      ariaLabel: `Redeemability: ${accessLabel} — jump to Redemption Backstop`,
    });
  }

  if (mintAuthorityReviewed) {
    items.push({
      key: "minting",
      category: "Minting",
      value: mintAuthority.mintPathShortLabel,
      href: "#mint-authority",
      ariaLabel: `Minting: ${mintAuthority.mintPathLabel} — jump to Mint Authority`,
    });
  }

  items.push(buildFreezePassportItem(coin, blacklistStatus, mintAuthorityReviewed));

  // Peg track record — the passport-stamp analogue. Counts are public incident
  // projections; the history surface exposes their constituent crossings.
  if (
    !isNavToken &&
    pegScoreResult &&
    pegScoreResult.depegEventCoverageLimited !== true &&
    typeof pegScoreResult.eventCount === "number"
  ) {
    const eventCount = pegScoreResult.eventCount;
    items.push(
      eventCount === 0
        ? {
            key: "record",
            category: "Record",
            value: "0 recorded",
            href: "#depeg-history",
            ariaLabel: "Peg record: no depeg incidents recorded in the score coverage window — jump to Depeg History",
          }
        : {
            key: "record",
            category: "Record",
            value: `${eventCount} incident${eventCount === 1 ? "" : "s"}`,
            href: "#depeg-history",
            ariaLabel: `Peg record: ${eventCount} depeg incident${eventCount === 1 ? "" : "s"} in the score coverage window — jump to Depeg History`,
          },
    );
  }

  items.push({
    key: "chains",
    category: "Chains",
    value: String(chainCount),
    href: (coin.contracts?.length ?? 0) > 0 ? "#contracts" : "#info",
    chip: true,
    ariaLabel: `Deployed on ${chainCount} chain${chainCount === 1 ? "" : "s"} — jump to contract deployments`,
  });

  // Cluster 2 — who stands behind it: jurisdiction, its regulatory visas,
  // reserve attestor, date of issue.
  const jurisdictionTooltipLines = jurisdictionCountry
    ? [jurisdictionCountry, coin.jurisdiction?.regulator, coin.jurisdiction?.license].filter((line): line is string =>
        Boolean(line),
      )
    : [];
  items.push({
    key: "jurisdiction",
    category: "Jurisdiction",
    value: jurisdictionCountry ? (COUNTRY_PASSPORT_CODES[jurisdictionCountry] ?? jurisdictionCountry) : "Not disclosed",
    href: isDecentralized ? "#info" : "#jurisdiction",
    valueClass: jurisdictionCountry ? undefined : HERO_MUTED_CLASS,
    tooltipLines: jurisdictionTooltipLines.length > 1 ? jurisdictionTooltipLines : undefined,
    ariaLabel: jurisdictionCountry
      ? `Jurisdiction: ${jurisdictionTooltipLines.join(", ")} — jump to jurisdiction details`
      : "Jurisdiction not disclosed — jump to Key Information",
  });

  // Regulatory visas: MiCA jumps to its proof badge in the jurisdiction block;
  // frozen assets carry the Key Information card's "Historical MiCA" framing.
  if (coin.mica) {
    const micaStyle = MICA_STATUS_BADGE_STYLES[coin.mica.status];
    const micaPrefix = coin.status === "frozen" ? "Historical MiCA" : "MiCA";
    items.push({
      key: "mica",
      category: "MiCA",
      value: micaStyle.label,
      href: "#jurisdiction",
      valueClass: micaStyle.textCls,
      ariaLabel: `${micaPrefix} status: ${micaStyle.label} — jump to jurisdiction details`,
    });
  }

  // GENIUS renders nowhere on the detail page yet, so the visa links off-page
  // to the Compliance Tracker (the Freeze field's FreezeWatch precedent). The
  // regime is still in rulemaking, so the aria-label frames the value as
  // pathway status — never a present-day federal license.
  const geniusStatus = coin.genius?.authorizationStatus;
  if (geniusStatus && geniusStatus !== "not-applicable" && geniusStatus !== "unknown") {
    const geniusLabel = GENIUS_STATUS_SHORT_LABELS[geniusStatus];
    items.push({
      key: "genius",
      category: "GENIUS",
      value: geniusLabel,
      href: "/compliance/?regime=genius",
      valueClass: GENIUS_STATUS_TEXT_CLS[geniusStatus],
      ariaLabel: `GENIUS Act pathway: ${geniusLabel} (regime effective ${GENIUS_REGIME_STATE.effectiveDate}) — view the Compliance Tracker`,
    });
  }

  if (!isDecentralized && coin.proofOfReserves) {
    const attestorTier = coin.proofOfReserves.attestorTier ?? null;
    const tierStyle = attestorTier ? POR_TIER_STYLES[attestorTier] : null;
    const attestorLabel = tierStyle?.label ?? POR_BADGE_STYLES[coin.proofOfReserves.type].label;
    items.push({
      key: "attestor",
      category: "Attestor",
      value: attestorTier ? ATTESTOR_PASSPORT_LABELS[attestorTier] : attestorLabel,
      href: "#attestation",
      valueClass: tierStyle?.textCls,
      ariaLabel: `Reserve attestation: ${attestorLabel} — jump to Proof of Reserves`,
    });
  }

  // Date of issue: year only protects the strip's one-line width budget; the
  // full date lives in the aria-label and the Key Information proof line.
  if (coin.launchDate) {
    const launchDateLong = formatLaunchDate(coin.launchDate);
    if (launchDateLong) {
      items.push({
        key: "issued",
        category: "Issued",
        value: coin.launchDate.slice(0, 4),
        href: "#info",
        ariaLabel: `Issued: launched ${launchDateLong} — jump to Key Information`,
      });
    }
  }

  return items;
}
