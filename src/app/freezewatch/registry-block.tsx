import Link from "next/link";
import { buildBlacklistStatusBuckets } from "@shared/lib/blacklist-status-buckets";
import {
  BLACKLIST_RETIRED_LEDGER_SPECS,
  BLACKLIST_TRACKED_STABLECOIN_ID_LIST,
  getBlacklistStablecoinById,
} from "@shared/lib/blacklist-contract-specs";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import {
  FREEZEWATCH_BUCKET_DESCRIPTIONS,
  FREEZEWATCH_BUCKET_LABELS,
} from "@/components/freezewatch/bucket-display";

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
              {FREEZEWATCH_BUCKET_LABELS[bucket.key]}: {bucket.count} active {bucket.count === 1 ? "coin" : "coins"}
            </dt>
            <dd className="pharos-meta">{FREEZEWATCH_BUCKET_DESCRIPTIONS[bucket.key]}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">Assets with event tracking</h3>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {BLACKLIST_TRACKED_STABLECOIN_ID_LIST.map((id) => {
            const label = CLIENT_TRACKED_META_BY_ID.get(id)?.symbol ?? getBlacklistStablecoinById(id) ?? id;
            return (
              <li key={id}>
                <Link href={buildStablecoinUrl(id)} className="underline">{label}</Link>
              </li>
            );
          })}
        </ul>
        <p className="pharos-meta">
          Retired archives (historical ledger only):{" "}
          {BLACKLIST_RETIRED_LEDGER_SPECS.map((entry, index) => (
            <span key={entry.stablecoinId}>
              {index > 0 ? ", " : null}
              <Link href={buildStablecoinUrl(entry.stablecoinId)} className="underline">
                {CLIENT_TRACKED_META_BY_ID.get(entry.stablecoinId)?.symbol ?? entry.stablecoin}
              </Link>
            </span>
          ))}
        </p>
      </div>
    </section>
  );
}
