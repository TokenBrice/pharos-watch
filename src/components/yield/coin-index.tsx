"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { CLIENT_ACTIVE_STABLECOINS as TRACKED_STABLECOINS, loadClientStablecoinDetail } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinClientDetailMeta } from "@shared/types/stablecoin-client-meta";
import type { YieldType } from "@shared/types";

interface CoinIndexEntry {
  id: string;
  symbol: string;
}

interface CoinIndexGroup {
  key: YieldType | "unclassified";
  label: string;
  badgeClassName: string | null;
  coins: CoinIndexEntry[];
}

// Display order chosen to match the source-lane prominence in /yield data:
// the dominant lanes (Lending Opp., NAV, Native) lead, niche surfaces follow,
// and unclassified yield-bearing coins surface at the end so they remain
// crawlable without diluting the taxonomy.
const COIN_INDEX_TYPE_ORDER: readonly YieldType[] = [
  "lending-opportunity",
  "nav-appreciation",
  "lending-vault",
  "rebase",
  "fee-sharing",
  "governance-set",
  "lp-receipt",
];
function buildCoinIndexGroups(detailsById: ReadonlyMap<string, StablecoinClientDetailMeta>): CoinIndexGroup[] {
  const buckets = new Map<YieldType | "unclassified", CoinIndexEntry[]>();

  for (const coin of TRACKED_STABLECOINS) {
    if (!coin.flags?.yieldBearing) continue;
    const yieldType = detailsById.get(coin.id)?.yieldConfig?.yieldType ?? coin.yieldType ?? "unclassified";
    const list = buckets.get(yieldType);
    const entry: CoinIndexEntry = { id: coin.id, symbol: coin.symbol };
    if (list) list.push(entry);
    else buckets.set(yieldType, [entry]);
  }

  for (const list of buckets.values()) {
    list.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  const groups: CoinIndexGroup[] = [];
  for (const yieldType of COIN_INDEX_TYPE_ORDER) {
    const coins = buckets.get(yieldType);
    if (!coins || coins.length === 0) continue;
    groups.push({
      key: yieldType,
      label: YIELD_TYPE_LABELS[yieldType] ?? yieldType,
      badgeClassName: YIELD_TYPE_STYLES[yieldType]?.badge ?? null,
      coins,
    });
  }

  const unclassified = buckets.get("unclassified");
  if (unclassified && unclassified.length > 0) {
    groups.push({
      key: "unclassified",
      label: "Other",
      badgeClassName: null,
      coins: unclassified,
    });
  }

  return groups;
}

export function YieldCoinIndex() {
  const [detailsById, setDetailsById] = useState<ReadonlyMap<string, StablecoinClientDetailMeta>>(new Map());
  const yieldBearingIds = useMemo(
    () => TRACKED_STABLECOINS.filter((coin) => coin.flags?.yieldBearing).map((coin) => coin.id),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all(yieldBearingIds.map((id) => loadClientStablecoinDetail(id))).then((details) => {
      if (cancelled) return;
      setDetailsById(
        new Map(
          details
            .filter((detail): detail is StablecoinClientDetailMeta => detail != null)
            .map((detail) => [detail.id, detail]),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [yieldBearingIds]);

  const groups = useMemo(() => buildCoinIndexGroups(detailsById), [detailsById]);
  if (groups.length === 0) return null;
  const totalCoins = groups.reduce((sum, group) => sum + group.coins.length, 0);

  return (
    <section
      aria-labelledby="yield-coin-index-heading"
      className="pharos-card-shell overflow-hidden"
    >
      <div className="pharos-panel-header space-y-1">
        <p className="pharos-kicker">Browse</p>
        <h2
          id="yield-coin-index-heading"
          className="text-lg font-semibold tracking-tight text-foreground"
        >
          Per-coin yield detail
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {totalCoins} yield-bearing tracked coins, grouped by how they earn. Jump to a coin&rsquo;s
          dedicated yield page for arbitration history, alternates, and methodology.
        </p>
      </div>

      <dl className="divide-y divide-border/60">
        {groups.map((group) => (
          <div
            key={group.key}
            className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4 sm:px-5"
          >
            <dt className="flex shrink-0 items-center gap-2 sm:w-44 sm:shrink-0">
              {group.badgeClassName ? (
                <Badge variant="outline" className={`text-[11px] ${group.badgeClassName}`}>
                  {group.label}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[11px] text-muted-foreground">
                  {group.label}
                </Badge>
              )}
              <span className="pharos-numeric text-xs text-muted-foreground">
                {group.coins.length}
              </span>
            </dt>
            <dd className="min-w-0 flex-1">
              <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
                {group.coins.map((coin) => (
                  <li key={coin.id}>
                    <Link
                      href={buildStablecoinUrl(coin.id, "yield/")}
                      className="pharos-focus-ring rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {coin.symbol}
                    </Link>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
      </dl>

      <p className="border-t border-border/60 px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-5">
        The Pharos Yield Score (PYS) is for informational purposes only and does not constitute
        financial advice. APY figures blend deterministic on-chain, benchmark-derived, DeFiLlama,
        and price-derived sources with confidence-aware arbitration. Past yields do not guarantee
        future returns.
      </p>
    </section>
  );
}
