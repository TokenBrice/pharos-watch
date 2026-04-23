import Image from "next/image";
import Link from "next/link";
import type { PegCurrency } from "@shared/types";
import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { IndexGlyph, MoonGlyph, SunGlyph } from "@/app/alt-pegs/fiat-world-atlas/non-geo-glyphs";
import { buildPegEmblemsForPegs, type PegEmblem } from "@/lib/alt-peg-emblems";

type BodyKind = "sun" | "moon" | "index";

interface Body {
  kind: BodyKind;
  item: AltPegLinkHubItem;
  pegs: readonly PegCurrency[];
}

/**
 * Percent-based anchors (relative to the `.fiat-world-map` container) for the
 * non-geographic cohorts that float over ocean deadspots on the desktop atlas.
 *   - GOLD   → North Pacific
 *   - SILVER → North Atlantic
 *   - CPI    → Indian Ocean
 */
export const DEADSPOT_ANCHORS: Record<BodyKind, { x: number; y: number }> = {
  sun: { x: 14, y: 38 },
  moon: { x: 36, y: 30 },
  index: { x: 66, y: 58 },
};

function pickBodies(items: readonly AltPegLinkHubItem[]): Body[] {
  const byPeg = new Map(items.map((item) => [item.peg, item]));
  const bodies: Body[] = [];
  const gold = byPeg.get("GOLD");
  if (gold) bodies.push({ kind: "sun", item: gold, pegs: [gold.peg] });
  const silver = byPeg.get("SILVER");
  if (silver) bodies.push({ kind: "moon", item: silver, pegs: [silver.peg] });
  const index = items.filter((i) => i.peg !== "GOLD" && i.peg !== "SILVER" && i.region === "Other");
  if (index.length > 0) {
    const coinCount = index.reduce((sum, i) => sum + i.coinCount, 0);
    const symbolPreview = index
      .map((i) => i.symbolPreview)
      .filter(Boolean)
      .join(" · ");
    bodies.push({
      kind: "index",
      pegs: index.map((item) => item.peg),
      item: {
        ...index[0],
        label: index.length === 1 ? index[0].label : "Index-linked",
        coinCount,
        symbolPreview,
      },
    });
  }
  return bodies;
}

function orderBySymbolPreview(emblems: readonly PegEmblem[], symbolPreview: string): readonly PegEmblem[] {
  const previewRanks = new Map(
    symbolPreview
      .split(" · ")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean)
      .map((symbol, index) => [symbol, index]),
  );
  if (previewRanks.size === 0) return emblems;

  return [...emblems].sort((left, right) => {
    const leftRank = previewRanks.get(left.symbol.toUpperCase()) ?? Number.POSITIVE_INFINITY;
    const rightRank = previewRanks.get(right.symbol.toUpperCase()) ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.symbol.localeCompare(right.symbol);
  });
}

function DeadspotLogoStack({
  pegs,
  symbolPreview,
  maxVisible = 3,
}: {
  pegs: readonly PegCurrency[];
  symbolPreview: string;
  maxVisible?: number;
}) {
  const emblems = orderBySymbolPreview(buildPegEmblemsForPegs(pegs), symbolPreview);
  if (emblems.length === 0) return null;

  const visible = emblems.slice(0, maxVisible);
  const overflow = emblems.length - visible.length;

  return (
    <span className="absolute bottom-0 left-1/2 flex -translate-x-1/2 items-center rounded-full border border-white/15 bg-slate-950/82 px-1 py-0.5 shadow-[0_4px_12px_oklch(0_0_0_/0.38)]">
      {visible.map((emblem, index) => (
        <span
          key={emblem.id}
          className={
            index === 0
              ? "inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-full border border-white/20 bg-slate-100"
              : "-ml-1.5 inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-full border border-white/20 bg-slate-100"
          }
          title={`${emblem.name} (${emblem.symbol})`}
        >
          <Image
            src={emblem.logoSrc}
            alt=""
            width={16}
            height={16}
            unoptimized
            className="h-full w-full rounded-full object-contain"
          />
        </span>
      ))}
      {overflow > 0 ? (
        <span className="ml-0.5 font-mono text-[9px] font-semibold leading-none text-white">+{overflow}</span>
      ) : null}
    </span>
  );
}

export function MapDeadspotReferences({ items }: { items: readonly AltPegLinkHubItem[] }) {
  const bodies = pickBodies(items);
  if (bodies.length === 0) return null;

  return (
    <ul data-testid="map-deadspot-references" className="pointer-events-none absolute inset-0 m-0 list-none p-0">
      {bodies.map((body) => {
        const { kind, item, pegs } = body;
        const anchor = DEADSPOT_ANCHORS[kind];
        return (
          <li
            key={kind}
            data-body-kind={kind}
            data-peg={item.peg}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
            style={{ left: `${anchor.x}%`, top: `${anchor.y}%` }}
          >
            <Link
              href={item.href}
              aria-label={`${item.label}, ${item.coinCount} coins`}
              className="pharos-focus-ring pointer-events-auto inline-flex h-16 w-16 items-center justify-center rounded-full"
            >
              <span aria-hidden="true" className="relative block h-16 w-16">
                <span className="absolute inset-1 block">
                  {kind === "sun" ? <SunGlyph color={item.colorHex} /> : null}
                  {kind === "moon" ? <MoonGlyph color={item.colorHex} /> : null}
                  {kind === "index" ? <IndexGlyph color={item.colorHex} /> : null}
                </span>
                <DeadspotLogoStack pegs={pegs} symbolPreview={item.symbolPreview} />
              </span>
            </Link>
            <span className="flex flex-col items-center gap-0.5 text-center">
              <span className="text-sm font-semibold tracking-tight text-foreground dark:text-white">{item.label}</span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground dark:text-slate-300/82">
                {item.coinCount} coin{item.coinCount === 1 ? "" : "s"}
                {item.symbolPreview ? ` · ${item.symbolPreview}` : ""}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
