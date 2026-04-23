import Link from "next/link";
import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { IndexGlyph, MoonGlyph, SunGlyph } from "@/app/alt-pegs/fiat-world-atlas/non-geo-glyphs";

type BodyKind = "sun" | "moon" | "index";

interface Body {
  kind: BodyKind;
  item: AltPegLinkHubItem;
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
  if (gold) bodies.push({ kind: "sun", item: gold });
  const silver = byPeg.get("SILVER");
  if (silver) bodies.push({ kind: "moon", item: silver });
  const index = items.filter((i) => i.peg !== "GOLD" && i.peg !== "SILVER" && i.region === "Other");
  if (index.length > 0) {
    const coinCount = index.reduce((sum, i) => sum + i.coinCount, 0);
    const symbolPreview = index
      .map((i) => i.symbolPreview)
      .filter(Boolean)
      .join(" · ");
    bodies.push({
      kind: "index",
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

export function MapDeadspotReferences({ items }: { items: readonly AltPegLinkHubItem[] }) {
  const bodies = pickBodies(items);
  if (bodies.length === 0) return null;

  return (
    <ul data-testid="map-deadspot-references" className="pointer-events-none absolute inset-0 m-0 list-none p-0">
      {bodies.map((body) => {
        const { kind, item } = body;
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
              className="pharos-focus-ring pointer-events-auto inline-flex h-14 w-14 items-center justify-center rounded-full"
            >
              <span aria-hidden="true" className="block h-14 w-14">
                {kind === "sun" ? <SunGlyph color={item.colorHex} /> : null}
                {kind === "moon" ? <MoonGlyph color={item.colorHex} /> : null}
                {kind === "index" ? <IndexGlyph color={item.colorHex} /> : null}
              </span>
            </Link>
            <span className="flex flex-col items-center gap-0.5 text-center">
              <span className="text-sm font-semibold tracking-tight text-white">{item.label}</span>
              <span className="font-mono text-[10px] tabular-nums text-slate-300/82">
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
