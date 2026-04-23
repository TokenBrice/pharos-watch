import type { CSSProperties } from "react";
import Link from "next/link";
import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";

const REGION_ACCENT: Record<Exclude<AltPegRegion, "Other">, string> = {
  Americas: "#3b82f6",
  Europe: "#8b5cf6",
  Asia: "#14b8a6",
  Africa: "#d946ef",
  Oceania: "#6366f1",
};

function withAlpha(hex: string, alpha: string): string {
  return hex.startsWith("#") && hex.length === 7 ? `${hex}${alpha}` : hex;
}

function formatCoinCount(n: number): string {
  return `${n} coin${n === 1 ? "" : "s"}`;
}
function formatCohortCount(n: number): string {
  return `${n} cohort${n === 1 ? "" : "s"}`;
}

export function RegionSummaryPill({
  region,
  coinCount,
  cohortCount,
}: {
  region: Exclude<AltPegRegion, "Other">;
  coinCount: number;
  cohortCount: number;
}) {
  const accentHex = REGION_ACCENT[region];
  return (
    <div
      className="inline-flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5"
      style={{
        borderColor: withAlpha(accentHex, "24"),
        backgroundColor: withAlpha(accentHex, "0d"),
      }}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: accentHex }} />
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/92">{region}</span>
      <span className="font-mono text-[11px] tabular-nums text-slate-300/86">
        {formatCohortCount(cohortCount)} · {formatCoinCount(coinCount)}
      </span>
    </div>
  );
}

export function LinkChip({ item }: { item: AltPegLinkHubItem }) {
  const style: CSSProperties = {
    borderColor: withAlpha(item.colorHex, "26"),
    backgroundColor: withAlpha(item.colorHex, "0d"),
  };
  return (
    <Link
      href={item.href}
      aria-label={`${item.label}, ${formatCoinCount(item.coinCount)}${item.symbolPreview ? `. ${item.symbolPreview}` : ""}`}
      style={style}
      className="pharos-focus-ring inline-flex min-h-10 flex-col rounded-lg border border-white/10 bg-white/[0.045] px-3 py-2 text-left transition-[background-color,border-color,color] hover:border-white/30 hover:bg-white/[0.08]"
    >
      <span className="inline-flex items-center gap-2 text-sm font-medium text-white">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.colorHex }} />
        {item.label}
      </span>
      <span className="mt-1 font-mono text-[11px] tabular-nums text-slate-300/86">
        {formatCoinCount(item.coinCount)}
        {item.symbolPreview ? ` · ${item.symbolPreview}` : ""}
      </span>
    </Link>
  );
}

export function FiatRegionSection({ region, items }: { region: AltPegRegion; items: readonly AltPegLinkHubItem[] }) {
  const slug = region.toLowerCase().replace(/\s+/g, "-");
  const coinCount = items.reduce((sum, i) => sum + i.coinCount, 0);
  const accentHex = region === "Other" ? (items[0]?.colorHex ?? "#64748b") : REGION_ACCENT[region];
  return (
    <section aria-labelledby={`alt-peg-region-${slug}`} className="space-y-2" data-region={region}>
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accentHex }} />
          <h4
            id={`alt-peg-region-${slug}`}
            className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/90"
          >
            {region}
          </h4>
        </div>
        <p className="font-mono text-[11px] tabular-nums text-slate-300/86">
          {formatCohortCount(items.length)} · {formatCoinCount(coinCount)}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 lg:gap-1.5">
        {items.map((item) => (
          <LinkChip key={item.href} item={item} />
        ))}
      </div>
    </section>
  );
}
