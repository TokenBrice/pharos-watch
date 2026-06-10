import type { MechanismArchetype, RedemptionBackstopEntry, StablecoinMeta } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type { BlacklistStatus } from "@shared/lib/report-cards";
import {
  BACKING_BADGE_STYLES,
  MECHANISM_ARCHETYPE_SHORT_LABELS,
  POR_BADGE_STYLES,
  POR_TIER_STYLES,
} from "@shared/lib/classification";
import { REDEMPTION_ACCESS_LABELS } from "@shared/lib/redemption-backstop-scoring";
import { buildCoinTrackerLink } from "@/lib/coin-tracker-links";
import { HERO_MUTED_CLASS } from "@/lib/stablecoin-detail-hero-metrics";

export interface HeroPassportItemViewModel {
  key: "mechanism" | "attestor" | "jurisdiction" | "redeemability" | "minting" | "freeze" | "chains";
  category: "Mechanism" | "Attestor" | "Jurisdiction" | "Redeemability" | "Minting" | "Freeze" | "Chains";
  /** Authored-short value from a bounded vocabulary — never CSS-truncated. */
  value: string;
  href: string;
  /** Text tone on the value for data-driven states (freeze, attestor tier). */
  valueClass?: string;
  ariaLabel: string;
}

/** Structural slice of MintAuthorityDetailViewModel the passport needs. */
export interface PassportMintAuthorityInput {
  status: "reviewed" | "not-reviewed";
  mintPathLabel: string;
}

// Same data-driven freeze tones as the retired identity FreezablePill — amber
// for any freeze surface, emerald only for a reviewed clear status. Text-only:
// passport entries are flat document fields, not tinted pills.
const FREEZE_TONE_RESTRICTED = "text-amber-700 dark:text-amber-400";
const FREEZE_TONE_CLEAR = "text-emerald-700 dark:text-emerald-400";

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
 * The hero "passport" row: the verification facts (mechanism, attestor,
 * jurisdiction, redeemability, minting, freeze powers, chain count) as
 * document-style anchor entries. Entries whose dedicated proof block does not
 * render fall back to `#info`; the attestor entry is omitted entirely for
 * decentralized coins (mirroring the Key Information card's skip), and the
 * redeemability/minting entries are omitted when their datasets have no
 * reviewed record for the coin.
 */
export function buildHeroPassportItems({
  coin,
  chainCount,
  blacklistStatus,
  resolvedMechanismArchetype,
  mintAuthority,
  redemptionBackstop,
}: {
  coin: StablecoinMeta;
  chainCount: number;
  blacklistStatus: BlacklistStatus | null;
  resolvedMechanismArchetype: MechanismArchetype | null;
  mintAuthority: PassportMintAuthorityInput;
  redemptionBackstop: RedemptionBackstopEntry | null;
}): HeroPassportItemViewModel[] {
  const isDecentralized = coin.flags.governance === "decentralized";
  const hasMechanismBlock = Boolean(coin.collateral || coin.pegMechanism);
  const mintAuthorityReviewed = mintAuthority.status === "reviewed";
  const mechanismValue = resolvedMechanismArchetype
    ? MECHANISM_ARCHETYPE_SHORT_LABELS[resolvedMechanismArchetype]
    : (BACKING_BADGE_STYLES[coin.flags.backing]?.label ?? coin.flags.backing);
  const jurisdictionCountry = coin.jurisdiction?.country ?? null;

  const items: HeroPassportItemViewModel[] = [
    {
      key: "mechanism",
      category: "Mechanism",
      value: mechanismValue,
      href: hasMechanismBlock ? "#mechanism" : "#info",
      ariaLabel: `Peg mechanism: ${mechanismValue} — jump to Key Information`,
    },
  ];

  if (!isDecentralized && coin.proofOfReserves) {
    const tierStyle = coin.proofOfReserves.attestorTier
      ? POR_TIER_STYLES[coin.proofOfReserves.attestorTier]
      : null;
    const attestorLabel = tierStyle?.label ?? POR_BADGE_STYLES[coin.proofOfReserves.type].label;
    items.push({
      key: "attestor",
      category: "Attestor",
      value: attestorLabel,
      href: "#attestation",
      valueClass: tierStyle?.textCls,
      ariaLabel: `Reserve attestation: ${attestorLabel} — jump to Proof of Reserves`,
    });
  }

  items.push({
    key: "jurisdiction",
    category: "Jurisdiction",
    value: jurisdictionCountry ?? "Not disclosed",
    href: isDecentralized ? "#info" : "#jurisdiction",
    valueClass: jurisdictionCountry ? undefined : HERO_MUTED_CLASS,
    ariaLabel: jurisdictionCountry
      ? `Jurisdiction: ${jurisdictionCountry} — jump to jurisdiction details`
      : "Jurisdiction not disclosed — jump to Key Information",
  });

  if (redemptionBackstop) {
    const accessLabel = REDEMPTION_ACCESS_LABELS[redemptionBackstop.accessModel];
    items.push({
      key: "redeemability",
      category: "Redeemability",
      value: accessLabel,
      href: "#redemption",
      ariaLabel: `Redeemability: ${accessLabel} — jump to Redemption Backstop`,
    });
  }

  if (mintAuthorityReviewed) {
    items.push({
      key: "minting",
      category: "Minting",
      value: mintAuthority.mintPathLabel,
      href: "#mint-authority",
      ariaLabel: `Minting: ${mintAuthority.mintPathLabel} — jump to Mint Authority`,
    });
  }

  items.push(
    buildFreezePassportItem(coin, blacklistStatus, mintAuthorityReviewed),
    {
      key: "chains",
      category: "Chains",
      value: String(chainCount),
      href: (coin.contracts?.length ?? 0) > 0 ? "#contracts" : "#info",
      ariaLabel: `Deployed on ${chainCount} chain${chainCount === 1 ? "" : "s"} — jump to contract deployments`,
    },
  );

  return items;
}
