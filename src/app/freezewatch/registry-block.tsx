import Link from "next/link";
import {
  BLACKLIST_STATUS_BUCKET_DESCRIPTIONS,
  BLACKLIST_STATUS_BUCKET_LABELS,
  buildBlacklistStatusBuckets,
} from "@shared/lib/blacklist-status-buckets";
import { BLACKLIST_STABLECOINS } from "@shared/types/blacklist";
import { coinIdBySymbol } from "@/lib/coin-id-by-symbol";

/** Registry-only facts (no live data): reviewed exposure classes and event-tracked assets. */
export function FreezeWatchRegistryBlock() {
  const buckets = buildBlacklistStatusBuckets(undefined);
  return (
    <section aria-label="Reviewed freeze exposure and tracked assets" className="space-y-4">
      <div className="space-y-1">
        <p className="pharos-label">Registry</p>
        <h2 className="pharos-section-title">Reviewed exposure classes and tracked assets</h2>
        <p className="pharos-meta max-w-3xl">
          Can the issuer or an admin freeze holder balances? Reviewed answers for active coins; these are classifications, not observed freezes.
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {buckets.map((bucket) => (
          <div key={bucket.key} className="space-y-1">
            <dt className="text-sm font-medium text-foreground">
              {BLACKLIST_STATUS_BUCKET_LABELS[bucket.key]}: {bucket.count} active {bucket.count === 1 ? "coin" : "coins"}
            </dt>
            <dd className="pharos-meta">{BLACKLIST_STATUS_BUCKET_DESCRIPTIONS[bucket.key]}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">Assets with event tracking</h3>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {BLACKLIST_STABLECOINS.map((symbol) => {
            const id = coinIdBySymbol(symbol);
            return (
              <li key={symbol}>
                {id ? <Link href={`/stablecoin/${id}/`} className="underline">{symbol}</Link> : symbol}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
