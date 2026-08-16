import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { logosById } from "@/lib/logos";
import { SectionHeading, SectionKicker } from "./section-primitives";

interface RelatedCoin {
  coinId: string;
  note: string;
}

interface RelatedCoinsListProps {
  coins: readonly RelatedCoin[];
  kickerClass: string;
  kicker: string;
  heading: string;
  id?: string;
}

export function RelatedCoinsList({
  coins,
  kickerClass,
  kicker,
  heading,
  id,
}: RelatedCoinsListProps) {
  if (coins.length === 0) return null;
  return (
    <section id={id} className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>{kicker}</SectionKicker>
        <SectionHeading>{heading}</SectionHeading>
      </div>
      <ul className="divide-y divide-border/40">
        {coins.map((coin) => {
          const meta = TRACKED_META_BY_ID.get(coin.coinId);
          if (!meta) return null;
          const logoSrc = logosById[coin.coinId];
          return (
            <li key={coin.coinId}>
              <Link
                href={buildStablecoinUrl(coin.coinId)}
                className="pharos-focus-ring group grid gap-3 py-5 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,16ch)_minmax(0,1fr)_auto] sm:items-baseline sm:gap-8"
              >
                <div className="flex items-start gap-2.5">
                  {logoSrc ? (
                    <img
                      src={logoSrc}
                      alt=""
                      aria-hidden="true"
                      width={20}
                      height={20}
                      className="mt-0.5 h-5 w-5 shrink-0 rounded-full"
                      loading="lazy"
                    />
                  ) : null}
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono text-sm font-semibold uppercase tracking-[0.04em] text-foreground transition-colors group-hover:text-frost-blue">
                      {meta.symbol}
                    </span>
                    <span className="text-xs leading-snug text-muted-foreground">
                      {meta.name}
                    </span>
                  </div>
                </div>
                <p className="text-[15px] leading-relaxed text-muted-foreground">
                  {coin.note}
                </p>
                <ArrowUpRight
                  className="hidden h-4 w-4 shrink-0 self-center text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-frost-blue sm:block"
                  aria-hidden="true"
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
