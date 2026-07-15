import { Ban, PauseCircle } from "lucide-react";
import type { StablecoinMeta } from "@shared/types";

type ListingStateCoin = Pick<StablecoinMeta, "status" | "listingStatusReview" | "symbol">;

export function ListingStateBanner({ coin }: { coin: ListingStateCoin }) {
  if ((coin.status !== "quarantined" && coin.status !== "delisted") || !coin.listingStatusReview) {
    return null;
  }

  const quarantined = coin.status === "quarantined";
  const Icon = quarantined ? PauseCircle : Ban;
  const title = quarantined ? "Live tracking temporarily paused" : "No longer listed by Pharos";

  return (
    <section
      aria-label={`${coin.symbol} listing status`}
      className="border-l-4 border-amber-500 bg-amber-500/8 px-4 py-3 text-sm"
    >
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-foreground">{title}</p>
          <p className="leading-relaxed text-muted-foreground">{coin.listingStatusReview.reason}</p>
          <p className="text-xs text-muted-foreground">
            Effective {coin.listingStatusReview.changedAt}
            {quarantined && coin.listingStatusReview.reviewBy
              ? `; review due ${coin.listingStatusReview.reviewBy}`
              : ""}
            {coin.listingStatusReview.source ? (
              <>
                {"; "}
                <a
                  href={coin.listingStatusReview.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pharos-focus-ring rounded-sm underline underline-offset-2 hover:text-foreground"
                >
                  {coin.listingStatusReview.source.label}
                </a>
              </>
            ) : null}
          </p>
        </div>
      </div>
    </section>
  );
}
