import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { LENDING_PROTOCOLS } from "./yield-config/yield-config-lending-venues";
import { YIELD_POOL_MAP } from "./yield-config/yield-config-pools";

const APP_LINK_LABEL_PRIORITY = ["App", "Portal", "Earn", "Mint", "Stake", "Dashboard"] as const;
const FALLBACK_LINK_LABEL_PRIORITY = [...APP_LINK_LABEL_PRIORITY, "Website", "Docs"] as const;
const APP_LIKE_DISPLAY_LABEL = /\b(app|earn|mint|portal|stake|vault)\b/i;

const DL_POOL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POOL_SOURCE_URLS: Record<string, string> = {
  "8b427366-7bfb-4c61-88be-8dc004fdc3da": "https://app.frankencoin.com/savings?chain=ethereum",
  "dac71f4f-7b97-463a-b19f-9796c56c21f1": "https://liquity.app/earn/sbold",
  "5fd328af-4203-471b-bd16-1705c726d926": "https://www.curve.finance/crvusd/ethereum/scrvUSD",
};

const LENDING_PROTOCOL_SOURCE_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(LENDING_PROTOCOLS).map(([slug, config]) => [slug, config.url]),
);

const YIELD_SOURCE_URLS: Record<string, string> = {
  ...Object.fromEntries(Object.values(LENDING_PROTOCOLS).map((config) => [config.label, config.url])),
  "B.Protocol Stability Pool (LQTY only)": "https://app.bprotocol.org/liquity",
  "BIMA savings (sUSBD)": "https://bima.money/earn",
  "Curve Savings (scrvUSD)": "https://www.curve.finance/crvusd/ethereum/scrvUSD",
  "Hashnote USYC": "https://usyc.hashnote.com/",
  "K3: sBOLD": "https://liquity.app/earn/sbold",
  "Liquity Stability Pool (via K3 sBOLD)": "https://liquity.app/earn/sbold",
  "Ondo USDY Oracle": "https://ondo.finance/usdy",
  "Compound V3 (ethereum)": "https://app.compound.finance/",
  "Compound V3 (base)": "https://app.compound.finance/",
  "Compound V3 (arbitrum)": "https://app.compound.finance/",
  "Maple Finance lending": "https://app.maple.finance/earn",
  Kong: "https://kong.yearn.fi/",
  // Tier C — 2026-05-13 audit additions
  // Wave 2 — category-gated thin-chain/app-chain lenders
  // Wave 3 — 2026-06-11 audit queue follow-up
  // 2026-09-23 coverage-audit drain promotions
  // Explicit-pool labels (parenthetical asset suffix is stripped by the label fallback chain)
  "Hydration Omnipool": "https://hydration.net/",
};

// DeFiLlama projects outside the lending allowlist, keyed by project slug.
const VENUE_PROTOCOL_SOURCE_URLS: Record<string, string> = {
  "bitwise-uscc": "https://superstate.com/assets/uscc",
  "blackrock-buidl": "https://securitize.io/blackrock/buidl",
  "project-0": "https://app.0.xyz/",
};

function pickMetaYieldUrl(stablecoinId: string): string | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return null;

  const linkByLabel = new Map<string, string>();
  for (const link of meta.links ?? []) {
    if (link.url && !linkByLabel.has(link.label)) {
      linkByLabel.set(link.label, link.url);
    }
  }

  for (const label of APP_LINK_LABEL_PRIORITY) {
    const url = linkByLabel.get(label);
    if (url) {
      return url;
    }
  }

  const liveDisplay = meta.liveReservesConfig?.display;
  if (liveDisplay?.url && liveDisplay.label && APP_LIKE_DISPLAY_LABEL.test(liveDisplay.label)) {
    return liveDisplay.url;
  }

  for (const label of FALLBACK_LINK_LABEL_PRIORITY) {
    const url = linkByLabel.get(label);
    if (url) {
      return url;
    }
  }

  return meta.links?.[0]?.url ?? liveDisplay?.url ?? null;
}

function resolveLinkedVariantSourceOwnerId(stablecoinId: string, sourceKey: string | null | undefined): string | null {
  const prefix = "linked-variant:";
  if (!sourceKey?.startsWith(prefix)) return null;

  const ownerId = sourceKey.slice(prefix.length).split(":", 1)[0]?.trim();
  if (!ownerId) return null;
  const ownerMeta = TRACKED_META_BY_ID.get(ownerId);
  return ownerMeta?.variantOf === stablecoinId ? ownerId : null;
}

// Own-key lookup: slugs and labels are upstream strings, so `constructor` or
// `__proto__` must not resolve to an inherited Object member.
function ownValue(map: Record<string, string>, key: string | null | undefined): string | null {
  return key && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

function resolveLabelUrl(label: string | null | undefined): string | null {
  if (!label) return null;
  const candidates = [
    label,
    label.replace(/\s+\([^)]*\)\s*$/, ""),
    label.split(":")[0]?.trim(),
    label.replace(/\s+\([^)]*\)\s*$/, "").split(":")[0]?.trim(),
  ];
  for (const candidate of candidates) {
    const url = ownValue(YIELD_SOURCE_URLS, candidate);
    if (url) return url;
  }
  return null;
}

export function resolveYieldSourceUrl(params: {
  stablecoinId: string;
  sourceKey: string | null;
  yieldSource?: string | null;
  /** Published venue protocol (the DeFiLlama project for pool rows), when known. */
  venueProtocol?: string | null;
}): string | null {
  const sourceOwnerId = resolveLinkedVariantSourceOwnerId(params.stablecoinId, params.sourceKey);
  const ownerId = sourceOwnerId ?? params.stablecoinId;
  const sourceKey = sourceOwnerId
    ? params.sourceKey!.slice(`linked-variant:${sourceOwnerId}:`.length)
    : params.sourceKey;

  if (sourceKey && DL_POOL_ID.test(sourceKey)) {
    const poolId = sourceKey.toLowerCase();
    const configuredUrl = POOL_SOURCE_URLS[poolId];
    if (configuredUrl) return configuredUrl;

    // A pinned native pool is the owner's own instrument, so the owner's
    // configured link is the yield source.
    if (YIELD_POOL_MAP[ownerId] === poolId) {
      const nativeUrl = pickMetaYieldUrl(ownerId);
      if (nativeUrl) return nativeUrl;
    }
    // Any other pool is a deposit venue: link the venue's own app, named by the
    // pool's project before the row label. An unrelated deposit venue must never
    // inherit an issuer app URL; DeFiLlama is the last resort for an unmapped venue.
    return ownValue(VENUE_PROTOCOL_SOURCE_URLS, params.venueProtocol)
      ?? ownValue(LENDING_PROTOCOL_SOURCE_URLS, params.venueProtocol)
      ?? resolveLabelUrl(params.yieldSource)
      ?? `https://defillama.com/yields/pool/${poolId}`;
  }

  // A weighted group represents multiple pools, not one addressable DL pool.
  if (sourceKey?.startsWith("defillama-weighted:")) return pickMetaYieldUrl(ownerId);

  const pendleMarket = sourceKey?.match(/^protocol-api:pendle:([a-z0-9-]+):(0x[0-9a-f]{40})$/i);
  if (pendleMarket) {
    return `https://app.pendle.finance/trade/markets/${pendleMarket[2].toLowerCase()}/swap?view=pt&chain=${pendleMarket[1].toLowerCase()}`;
  }

  if (sourceKey?.startsWith("royco-dawn:")) {
    return "https://dawn.royco.org/explore";
  }

  return resolveLabelUrl(params.yieldSource) ?? pickMetaYieldUrl(ownerId);
}
