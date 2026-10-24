import Link from "next/link";
import { PEG_LABELS_SHORT, STABLECOIN_STATUS_LABELS } from "@shared/lib/classification";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import type { StablecoinMeta } from "@shared/types";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { normalizeWhitespace } from "@/lib/page-metadata";
import { stripTermMarkup } from "@/lib/term-markup";

/** How many active same-parent variants the static "Variant relationship" block shows. */
export const VARIANT_SIBLING_DISPLAY_LIMIT = 4;

const INLINE_LINK_CLASS = "pharos-focus-ring rounded-sm text-frost-blue underline-offset-2 hover:underline";

const TRACKED_BY_SYMBOL: ReadonlyMap<string, readonly StablecoinMeta[]> = (() => {
  const groups = new Map<string, StablecoinMeta[]>();
  for (const coin of TRACKED_STABLECOINS) {
    const key = coin.symbol.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), coin]);
  }
  return groups;
})();

/** The siblings the static profile's "Variant relationship" block links to. */
export function getDisplayedVariantSiblings(coin: StablecoinMeta): StablecoinMeta[] {
  if (!coin.variantOf) return [];
  return TRACKED_STABLECOINS.filter(
    (candidate) =>
      candidate.variantOf === coin.variantOf &&
      candidate.id !== coin.id &&
      isActiveStablecoinMeta(candidate),
  ).slice(0, VARIANT_SIBLING_DISPLAY_LIMIT);
}

/**
 * Other tracked records sharing this coin's ticker (case-insensitive), minus
 * parent, child and sibling variants the profile already links as variants.
 */
export function getSameTickerStablecoins(coin: StablecoinMeta): StablecoinMeta[] {
  const group = TRACKED_BY_SYMBOL.get(coin.symbol.trim().toLowerCase()) ?? [];
  if (group.length < 2) return [];
  const siblingIds = new Set(getDisplayedVariantSiblings(coin).map((sibling) => sibling.id));
  return group.filter(
    (other) =>
      other.id !== coin.id &&
      other.id !== coin.variantOf &&
      other.variantOf !== coin.id &&
      !siblingIds.has(other.id) &&
      !getDisplayedVariantSiblings(other).some((sibling) => sibling.id === coin.id),
  );
}

/** First clause of the one-liner: text before the first comma, semicolon or colon. */
export function firstOneLinerClause(oneLiner: string | undefined): string | null {
  if (!oneLiner) return null;
  const text = normalizeWhitespace(stripTermMarkup(oneLiner));
  const clause = text.split(/[,;:](?=\s)/)[0]!.trim().replace(/\.$/, "");
  return clause || null;
}

export function SameTickerStablecoins({ coin }: { coin: StablecoinMeta }) {
  const others = getSameTickerStablecoins(coin);
  if (others.length === 0) return null;

  return (
    <section aria-labelledby={`same-ticker-${coin.id}`} className="pharos-inset px-3 py-3">
      <h3 id={`same-ticker-${coin.id}`} className="pharos-label">
        Other coins using the {coin.symbol} ticker
      </h3>
      <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-muted-foreground">
        {others.map((other) => {
          const clause = firstOneLinerClause(other.oneLiner);
          return (
            <li key={other.id}>
              <Link href={buildStablecoinUrl(other.id)} className={INLINE_LINK_CLASS}>
                {other.name} ({other.symbol})
              </Link>
              {` · ${STABLECOIN_STATUS_LABELS[other.status ?? "active"]} · ${
                PEG_LABELS_SHORT[other.flags.pegCurrency] ?? other.flags.pegCurrency
              }`}
              {clause ? `. ${clause}.` : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
