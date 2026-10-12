import * as React from "react";
import {
  OG_ROUTE_CARDS,
  OG_ROUTE_CARD_COLORS as C,
  OG_ROUTE_CARD_LAYOUT as L,
  ogRouteCardHost,
  type OgRouteCardKey,
  type OgRouteSupportItem,
  type OgRouteVisual,
} from "@shared/lib/og-route-cards";
import { OG_ROUTE_GLYPHS } from "@shared/lib/og-route-glyphs";
import { PharosMark } from "./shared";

/** One live figure with its generation stamp; every string is preformatted by the loader. */
export interface RouteCardLiveData {
  hero: string;
  context: string;
  /** At most three items; a failed item is dropped, never zeroed. */
  support: readonly OgRouteSupportItem[];
  visual?: OgRouteVisual;
  /** "As of 12 Oct 2026, 14:05 UTC · …" — names the hero's generation, not the render clock. */
  stamp: string;
}

export type RouteCardProps =
  | { cardKey: OgRouteCardKey; variant: "live"; data: RouteCardLiveData }
  | { cardKey: OgRouteCardKey; variant: "timeless" };

const CONTENT_WIDTH = L.width - 2 * L.paddingX;

function Header() {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        height: L.markSize,
        paddingBottom: 24,
        borderBottom: `1px solid ${C.rule}`,
        boxSizing: "content-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <PharosMark size={L.markSize} />
        <span style={{ fontSize: L.wordmarkSize, fontWeight: 700, color: C.textPrimary }}>Pharos</span>
      </div>
      <span style={{ fontFamily: "Geist Mono", fontSize: L.hostSize, color: C.textSecondary }}>pharos.watch</span>
    </div>
  );
}

function RouteGlyph({ cardKey }: { cardKey: OgRouteCardKey }) {
  return (
    <svg
      width={L.glyphSize}
      height={L.glyphSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke={C.textSecondary}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {OG_ROUTE_GLYPHS[cardKey].map(([Tag, attrs], index) => <Tag key={index} {...attrs} />)}
    </svg>
  );
}

function Kicker({ cardKey }: { cardKey: OgRouteCardKey }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: L.kickerTop - L.headerTop - L.markSize - 25 }}>
      <RouteGlyph cardKey={cardKey} />
      <span style={{ fontSize: L.kickerSize, color: C.textSecondary }}>{OG_ROUTE_CARDS[cardKey].kicker}</span>
    </div>
  );
}

function SupportRow({ items }: { items: readonly OgRouteSupportItem[] }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 28, marginTop: 24, fontFamily: "Geist Mono", fontSize: L.supportSize }}>
      {items.map((item) => {
        const text = typeof item === "string" ? item : item.text;
        return (
          <div key={text} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {typeof item !== "string" && (
              <div style={{ display: "flex", width: 14, height: 14, borderRadius: 7, backgroundColor: item.swatchHex }} />
            )}
            <span>{text}</span>
          </div>
        );
      })}
    </div>
  );
}

function Visual({ visual }: { visual: OgRouteVisual }) {
  if (visual.kind === "share-bar") {
    return (
      <div style={{ display: "flex", width: CONTENT_WIDTH, height: 14, marginTop: 20, borderRadius: 7, overflow: "hidden", backgroundColor: C.barTrack }}>
        {visual.shares.map((share, index) => (
          <div
            key={index}
            style={{ display: "flex", width: CONTENT_WIDTH * share, height: 14, backgroundColor: C.barInk[Math.min(index, C.barInk.length - 1)] }}
          />
        ))}
      </div>
    );
  }
  const max = Math.max(...visual.bars.map((bar) => bar.value), 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 24 }}>
      {visual.bars.map((bar, index) => (
        <div key={bar.label} style={{ display: "flex", alignItems: "center", gap: 20, fontFamily: "Geist Mono", fontSize: L.supportSize }}>
          <span style={{ width: 300 }}>{bar.text}</span>
          <div style={{ display: "flex", width: CONTENT_WIDTH - 320, height: 14, borderRadius: 7, backgroundColor: C.barTrack }}>
            <div
              style={{
                display: "flex",
                width: max > 0 ? (CONTENT_WIDTH - 320) * (bar.value / max) : 0,
                height: 14,
                borderRadius: 7,
                backgroundColor: C.barInk[Math.min(index, C.barInk.length - 1)],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Route share card. The live variant shows one hero figure stamped with its
 * generation; the timeless variant carries only the route promise and is the
 * fail-closed render whenever the hero is unavailable or stale.
 */
export function RouteCard(props: RouteCardProps) {
  const card = OG_ROUTE_CARDS[props.cardKey];
  return (
    <div
      style={{
        width: L.width,
        height: L.height,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        backgroundColor: C.background,
        color: C.textPrimary,
        fontFamily: "Geist Sans",
        borderTop: `${L.accentBarHeight}px solid ${C.accent}`,
        padding: `${L.headerTop - L.accentBarHeight}px ${L.paddingX}px 0`,
      }}
    >
      <Header />
      <Kicker cardKey={props.cardKey} />

      {props.variant === "live" ? (
        <div style={{ display: "flex", flexDirection: "column", marginTop: 20 }}>
          <span style={{ fontSize: L.heroSize, fontWeight: 700, lineHeight: 1.05, color: C.textPrimary }}>
            {props.data.hero}
          </span>
          <span style={{ marginTop: 8, fontSize: L.contextSize, color: C.textSecondary }}>
            {props.data.context}
          </span>
          {props.data.support.length > 0 && <SupportRow items={props.data.support} />}
          {props.data.visual && <Visual visual={props.data.visual} />}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", marginTop: 44 }}>
          {card.promise.map((line) => (
            <span
              key={line}
              style={{ fontSize: L.promiseSize, fontWeight: 700, lineHeight: `${L.promiseLineHeight}px`, color: C.textPrimary }}
            >
              {line}
            </span>
          ))}
        </div>
      )}

      <span
        style={{
          position: "absolute",
          left: L.paddingX,
          bottom: L.footerBottom - 6,
          fontFamily: "Geist Mono",
          fontSize: L.footerSize,
          color: C.textSecondary,
        }}
      >
        {props.variant === "live" ? props.data.stamp : `Live figures at ${ogRouteCardHost(card.path)}`}
      </span>
    </div>
  );
}
