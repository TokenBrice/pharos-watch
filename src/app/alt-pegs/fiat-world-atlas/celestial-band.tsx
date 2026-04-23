import Link from "next/link";
import type { CSSProperties } from "react";
import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";
import {
  IndexGlyph,
  MoonGlyph,
  SunGlyph,
} from "@/app/alt-pegs/fiat-world-atlas/non-geo-glyphs";

type OrbitalKind = "sun" | "moon" | "index";

interface OrbitalBody {
  kind: OrbitalKind;
  item: AltPegLinkHubItem;
}

function pickItems(items: readonly AltPegLinkHubItem[]): OrbitalBody[] {
  const byPeg = new Map(items.map((item) => [item.peg, item]));
  const bodies: OrbitalBody[] = [];
  const gold = byPeg.get("GOLD");
  if (gold) bodies.push({ kind: "sun", item: gold });
  const silver = byPeg.get("SILVER");
  if (silver) bodies.push({ kind: "moon", item: silver });
  const index = items.filter((i) => i.peg !== "GOLD" && i.peg !== "SILVER" && i.region === "Other");
  if (index.length > 0) {
    const coinCount = index.reduce((sum, i) => sum + i.coinCount, 0);
    const symbolPreview = index.map((i) => i.symbolPreview).filter(Boolean).join(" · ");
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

function bodySizePx(item: AltPegLinkHubItem, maxCoinCount: number): number {
  const emphasis = Math.sqrt(Math.max(1, item.coinCount) / Math.max(1, maxCoinCount));
  return Math.round(44 + emphasis * 44);
}

function Orbital({ body, maxCoinCount }: { body: OrbitalBody; maxCoinCount: number }) {
  const { kind, item } = body;
  const size = bodySizePx(item, maxCoinCount);
  const glyphStyle: CSSProperties = { width: size, height: size };

  return (
    <Link
      href={item.href}
      aria-label={`${item.label}, ${item.coinCount} coins`}
      className="pharos-focus-ring group inline-flex items-center gap-3 rounded-2xl border border-border/55 bg-background/55 px-3 py-2 transition-[background-color,border-color] hover:bg-accent/40"
      data-orbital={kind}
      data-peg={item.peg}
      data-coin-count={item.coinCount}
    >
      <span aria-hidden="true" className="relative grid place-items-center rounded-full" style={glyphStyle}>
        {kind === "sun" ? <SunGlyph color={item.colorHex} /> : null}
        {kind === "moon" ? <MoonGlyph color={item.colorHex} /> : null}
        {kind === "index" ? <IndexGlyph color={item.colorHex} /> : null}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold tracking-tight text-foreground">{item.label}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {item.coinCount} coin{item.coinCount === 1 ? "" : "s"}
          {item.symbolPreview ? ` · ${item.symbolPreview}` : ""}
        </span>
      </span>
    </Link>
  );
}

export function CelestialBand({ items }: { items: readonly AltPegLinkHubItem[] }) {
  const bodies = pickItems(items);
  if (bodies.length === 0) return null;
  const maxCoinCount = Math.max(1, ...bodies.map((b) => b.item.coinCount));

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border/20 px-4 py-3 sm:px-5 sm:py-4"
      data-testid="celestial-band"
    >
      <p className="mr-auto text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        References beyond geography
      </p>
      {bodies.map((body) => (
        <Orbital key={body.kind} body={body} maxCoinCount={maxCoinCount} />
      ))}
    </div>
  );
}
