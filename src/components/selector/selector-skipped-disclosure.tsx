"use client";

import type { SkippedCoin } from "@shared/lib/selector";

interface SelectorSkippedDisclosureProps {
  coins: readonly SkippedCoin[];
  defaultOpen?: boolean;
}

/**
 * Native `<details>` panel listing coins skipped for coverage thinness, with
 * the missing signal names per row. Surfaces names + missing signals per R1
 * (DAO Treasurer C5).
 */
export function SelectorSkippedDisclosure({
  coins,
  defaultOpen = false,
}: SelectorSkippedDisclosureProps) {
  if (coins.length === 0) return null;
  return (
    <details
      open={defaultOpen}
      className="rounded-lg border border-border/55 bg-card/40 px-3 py-2 text-sm"
    >
      <summary className="pharos-focus-ring cursor-pointer list-none rounded-sm font-medium text-foreground">
        Show skipped coins ({coins.length})
      </summary>
      <ul className="mt-3 space-y-2 border-t border-border/45 pt-3 text-muted-foreground">
        {coins.map((coin) => (
          <li key={coin.id} className="flex flex-wrap items-baseline gap-1.5">
            <span className="font-semibold text-foreground">{coin.symbol}</span>
            <span className="text-xs">
              missing: {coin.missingSignals.length > 0 ? coin.missingSignals.join(", ") : "data not yet captured"}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
