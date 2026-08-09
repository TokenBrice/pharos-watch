"use client";

import type { SkippedCoin } from "@shared/lib/selector";

interface SelectorSkippedDisclosureProps {
  coins: readonly SkippedCoin[];
}

/**
 * Native `<details>` panel listing coins skipped for coverage thinness, with
 * the missing signal names per row. Surfaces names + missing signals per R1
 * (DAO Treasurer C5).
 */
export function SelectorSkippedDisclosure({ coins }: SelectorSkippedDisclosureProps) {
  if (coins.length === 0) return null;
  return (
    <details className="rounded-lg border border-border/55 bg-card/40 px-3 py-2 text-sm">
      <summary className="pharos-focus-ring cursor-pointer rounded-sm font-medium text-foreground">
        Skipped coins disclosure ({coins.length})
      </summary>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        These tracked coins were excluded from the shortlist because required Selector signals were missing.
      </p>
      <ul className="mt-3 space-y-2 border-t border-border/45 pt-3 text-muted-foreground">
        {coins.map((coin) => (
          <li key={coin.id} className="flex min-w-0 flex-wrap items-baseline gap-1.5">
            <span className="font-semibold text-foreground">{coin.symbol}</span>
            <span className="min-w-0 break-words text-xs">
              missing: {coin.missingSignals.length > 0 ? coin.missingSignals.join(", ") : "data not yet captured"}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
