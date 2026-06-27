"use client";

import Link from "next/link";
import { Newspaper, Send } from "lucide-react";
import { useDailyDigest } from "@/hooks/api-hooks";
import { splitDigestParagraphs } from "@/lib/digest";
import { digestDisplay } from "@/lib/fonts/digest";
import { cn } from "@/lib/utils";

const FALLBACK_DIGEST_PREVIEW = {
  title: "USDC Bleeds $819M In A Week",
  text: "$819M out of Circle in seven days, $74.86B left on the books, 6% below April's ATH. Yield pages flag USDG, JTRSY, PAXG without corroboration. PMUSD still 3,464 bps underwater.",
} as const;

function compactDigestText(value: string | null | undefined): string | null {
  const compact = value?.replace(/\s+/g, " ").trim();
  return compact ? compact : null;
}

// Promo card sitting at the top-right of the Market Pulse band. Unlike its
// data siblings it carries no live signal, so it leads with the serif digest
// nameplate and two CTAs instead of the label + expand header pattern.
export function DailyDigestCard(): React.JSX.Element {
  const { data } = useDailyDigest();
  const title = compactDigestText(data?.digestTitle) ?? FALLBACK_DIGEST_PREVIEW.title;
  const editionPrefix = data?.editionNumber ? `#${data.editionNumber}` : null;
  const text =
    compactDigestText(data?.digest) ??
    compactDigestText(splitDigestParagraphs(data?.digestExtended)[0]) ??
    FALLBACK_DIGEST_PREVIEW.text;

  return (
    <div className="pharos-card-shell relative h-full min-h-0 overflow-hidden px-5 pt-7 text-center">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[-18%] bottom-[-4.25rem] h-44 bg-[radial-gradient(ellipse_at_center,oklch(0.64_0.11_190_/_0.32),oklch(0.36_0.07_205_/_0.18)_42%,transparent_72%)]"
      />
      <div className="relative z-10 space-y-2">
        <h3 className={`${digestDisplay.className} text-[2rem] font-semibold leading-none tracking-[-0.02em] text-foreground`}>
          Daily Digest
        </h3>
        <p className="mx-auto max-w-full whitespace-nowrap text-[12px] leading-snug text-muted-foreground">
          Updates from the world of stablecoins — every single day.
        </p>
      </div>

      <div className="relative z-10 mt-2 flex flex-wrap items-center justify-center gap-2">
        <DigestCardAction href="/digest/" icon={Newspaper}>
          View Digest
        </DigestCardAction>
        <DigestCardAction href="https://t.me/pharoswatch" icon={Send} external>
          Read on Telegram
        </DigestCardAction>
      </div>

      {/* Serif promo on a subtle layered-card stack — back leaves peek above
          and beside the front card to fake depth without using shadows. */}
      <div className="absolute inset-x-0 bottom-0 z-10 h-[160px] text-left">
        <div
          aria-hidden="true"
          className="absolute left-10 right-7 top-0 h-[150px] -rotate-[5deg] rounded-xl border border-border/35 bg-card/80"
        />
        <div
          aria-hidden="true"
          className="absolute left-8 right-5 top-4 h-[152px] -rotate-[1deg] rounded-xl border border-border/45 bg-card/90"
        />
        <div className="absolute inset-x-4 bottom-[-3.25rem] top-10 overflow-hidden rounded-xl border border-border/65 bg-card/95 p-4">
          <h4 className={`${digestDisplay.className} text-sm font-semibold uppercase leading-snug tracking-wide`}>
            {editionPrefix ? (
              <>
                <span className="text-teal-700 dark:text-teal-400">{editionPrefix}</span>
                {` — ${title}`}
              </>
            ) : (
              title
            )}
          </h4>
          <p className={`${digestDisplay.className} mt-2 text-xs leading-relaxed text-muted-foreground`}>
            {text}
          </p>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card via-card/85 to-transparent"
          />
        </div>
      </div>
    </div>
  );
}

function DigestCardAction({
  href,
  icon: Icon,
  external = false,
  children,
}: {
  href: string;
  icon: typeof Newspaper;
  external?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const className = cn(
    "pharos-focus-ring inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70",
    "bg-muted/70 px-2.5 text-sm font-medium leading-none text-foreground/90",
    "transition-colors hover:border-border hover:bg-muted hover:text-foreground",
  );

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        <span>{children}</span>
        <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      </a>
    );
  }

  return (
    <Link prefetch={false} href={href} className={className}>
      <span>{children}</span>
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}
