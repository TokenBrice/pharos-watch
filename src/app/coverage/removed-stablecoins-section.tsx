import Link from "next/link";
import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import { formatLongDate } from "@shared/lib/format";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { REMOVED_STABLECOINS, STABLECOIN_REMOVAL_REASON_LABELS } from "@/lib/removed-stablecoins";

/** Static list of coins Pharos stopped tracking; old profile links land on their cemetery record, peg hub or here. */
export function RemovedStablecoinsSection() {
  return (
    <section id="removed-from-coverage" className="pharos-card-shell px-4 py-4 sm:px-5" aria-labelledby="removed-from-coverage-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="removed-from-coverage-heading" className="pharos-section-title">
          Removed from coverage
        </h2>
        <span className="pharos-numeric inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          {REMOVED_STABLECOINS.length}
          <span className="sr-only"> removed coins</span>
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Stablecoins Pharos once tracked and later removed from its registry. Old profile links lead to the coin&apos;s
        cemetery record or matching currency page where one exists, otherwise here.
      </p>
      <ul className="mt-3 grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
        {REMOVED_STABLECOINS.map((coin) => {
          const pegLabel = PEG_LABELS_SHORT[coin.pegCurrency] ?? coin.pegCurrency;
          const pegHref = buildPegLandingUrl(coin.pegCurrency);
          return (
            <li key={coin.id} id={coin.id} className="min-w-0">
              <span className="font-medium text-foreground">{coin.name}</span>{" "}
              <span className="pharos-numeric text-xs text-muted-foreground">({coin.symbol})</span>
              <span className="block text-xs text-muted-foreground">
                {pegHref ? (
                  <Link href={pegHref} className="pharos-prose-link">
                    {pegLabel}
                  </Link>
                ) : (
                  pegLabel
                )}
                {" · "}Removed{" "}
                <time dateTime={coin.removedAt} className="pharos-numeric">
                  {formatLongDate(new Date(`${coin.removedAt}T00:00:00Z`), { utc: true })}
                </time>
                {" · "}
                {STABLECOIN_REMOVAL_REASON_LABELS[coin.reason]}
                {coin.cemeteryId ? (
                  <>
                    {" · "}
                    <Link href={`/cemetery/#${coin.cemeteryId}`} className="pharos-prose-link">
                      Cemetery record
                    </Link>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
