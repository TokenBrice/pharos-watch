"use client";

/**
 * Harbor 2.0 island (`/chains/`). Builds the pure scene and geometry from the chain snapshot and owns interaction:
 * one roving tab stop (↑/↓ berths in rank order, Home/End), hover/focus tag, pin (click/Enter/Space) with a record
 * card (docked ≥ 1280 px, in flow below, a bottom sheet ≤ 760 px), Escape or a click on the water to unpin, and the
 * `#chain-<id>` deep link through `HarborSelectionProvider`. There is no ambient motion: the beam only follows the
 * reader's selection and jumps (no tween), so reduced motion needs no special case.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useSceneLayout } from "@/components/scene/use-scene-layout";
import { formatEventTimestamp } from "@/lib/depeg-event-display";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import { buildHarborScene, isHarborChainVessel, stepHarborBerth, type HarborSceneInput, type HarborVessel } from "@shared/lib/harbor-scene";
import { buildHarborGeometry, type HarborBerthGeometry } from "@shared/lib/harbor-scene-geometry";
import { bbox } from "@shared/lib/scene/projection";
import { boxToFrameRect, placeInspectorCard, type SceneRect } from "@shared/lib/scene/placement";
import { placeOnFreeWater } from "./harbor-placement";
import { HarborRecordCard } from "./harbor-record-card";
import { HarborLegend } from "./harbor-legend";
import { HARBOR_KEYS_ID, HarborDefs, HarborSceneSvg, harborTokenStyle } from "./harbor-scene";
import { useHarborSelection } from "./harbor-selection-context";
import styles from "./harbor.module.css";

const HARBOR_NARROW_QUERY = "(max-width: 760px)";
const DOCK_QUERY = "(min-width: 1280px)";
/** Sticky chrome height and the Feedback button's corner (viewport px), as the Cemetery's card avoids them. */
const CHROME_TOP = 67;
const FEEDBACK_CORNER = { width: 170, height: 84 } as const;

function utcStamp(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function tagText(vessel: HarborVessel): string {
  if (!isHarborChainVessel(vessel)) return vessel.label;
  const health = vessel.flag.kind === "band" ? `${vessel.flag.label}${vessel.flag.score == null ? "" : ` ${vessel.flag.score}`}` : "NR";
  return `${vessel.chain.name} · ${formatCompactUsd(vessel.totalUsd)} · ${health}`;
}

export interface HarborHeroProps {
  data: HarborSceneInput;
  /** Query error with retained data: the scene draws in the retained state even if `_meta` says fresh. */
  retainedAfterError?: boolean;
}

export function HarborHero({ data, retainedAfterError = false }: HarborHeroProps): ReactElement {
  const layout = useSceneLayout(HARBOR_NARROW_QUERY);
  const preset = layout === "narrow" ? "narrow" : "wide";
  const scene = useMemo(() => buildHarborScene(data), [data]);
  const geometry = useMemo(() => buildHarborGeometry(scene, preset), [scene, preset]);
  const vessels = useMemo(() => new Map(scene.vessels.map((v) => [v.id, v])), [scene]);
  const berths = useMemo(() => new Map(geometry.berths.map((b) => [b.id, b])), [geometry]);
  const names = useMemo(() => new Map(data.chains.map((c) => [c.id, c.name])), [data.chains]);
  const { pinnedId, hoverChainId, pin, revealRow } = useHarborSelection();

  const [hotId, setHotId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const rovingId = focusId && vessels.has(focusId) ? focusId : (scene.vessels[0]?.id ?? null);
  const pinnedBerthId = pinnedId ? (scene.berthOf[pinnedId] ?? (vessels.has(pinnedId) ? pinnedId : null)) : null;
  const tableBerthId = hoverChainId ? (scene.berthOf[hoverChainId] ?? null) : null;
  const litId = hotId ?? tableBerthId ?? pinnedBerthId;
  const pinnedVessel = pinnedBerthId ? vessels.get(pinnedBerthId) : undefined;
  const focusChainId = pinnedVessel?.kind === "tail" && pinnedId !== pinnedBerthId ? pinnedId : null;

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const vb = geometry.viewBox;
  const vbW = vb.x1 - vb.x0;
  const vbH = vb.y1 - vb.y0;
  const at = (pt: readonly [number, number]): CSSProperties => ({ left: `${((pt[0] - vb.x0) / vbW) * 100}%`, top: `${((pt[1] - vb.y0) / vbH) * 100}%` });

  const togglePin = useCallback(
    (id: string) => {
      pin(pinnedBerthId === id ? null : id, "hero");
    },
    [pin, pinnedBerthId],
  );

  const focusBerth = (id: string) => {
    setFocusId(id);
    rootRef.current?.querySelector<HTMLElement>(`[data-berth="${CSS.escape(id)}"]`)?.focus();
  };

  const onBerthKeyDown = (id: string, event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = stepHarborBerth(scene.vessels, id, event.key);
      if (next) focusBerth(next);
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      togglePin(id);
    }
  };

  const onBerthActivate = (id: string, event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    setFocusId(id);
    togglePin(id);
  };

  const onRootKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && pinnedId) {
      pin(null, "hero");
      event.stopPropagation();
    }
  };

  const onSceneClick = (event: MouseEvent) => {
    if (!(event.target as Element).closest("[data-berth]") && pinnedId) pin(null, "hero");
  };

  // Hover / focus tag: on the nearest open water to the berth's deck, clear of hulls and quay labels (frame px).
  useLayoutEffect(() => {
    const tag = tagRef.current;
    const frame = frameRef.current;
    const berth = hotId ? berths.get(hotId) : undefined;
    if (!tag || !frame || !berth) return;
    const fr = frame.getBoundingClientRect();
    const scale = fr.width / vbW;
    const toFrame = ([x, y]: readonly [number, number]) => [(x - vb.x0) * scale, (y - vb.y0) * scale] as [number, number];
    const within = (el: Element): SceneRect => {
      const r = el.getBoundingClientRect();
      return { left: r.left - fr.left, top: r.top - fr.top, right: r.right - fr.left, bottom: r.bottom - fr.top };
    };
    const p = placeOnFreeWater({
      area: { left: 4, top: Math.max(4, CHROME_TOP - fr.top + 4), right: fr.width - 4, bottom: fr.height - 4 },
      size: { width: tag.offsetWidth, height: tag.offsetHeight },
      anchor: toFrame(berth.beamTarget),
      hulls: geometry.berths.map((b) => b.hit.map(toFrame)),
      labels: [...frame.querySelectorAll("[data-harbor-label]")].map(within),
      distanceWeight: 0.05,
    });
    tag.style.left = `${p.x}px`;
    tag.style.top = `${p.y}px`;
  }, [hotId, berths, geometry, vb.x0, vb.y0, vbW]);

  // Docked card (≥ 1280 px): beside the pinned berth, clear of the chrome and the Feedback corner.
  // `useSceneLayout` reports "narrow" while its query matches: here, while the viewport is wide enough to dock.
  const docked = useSceneLayout(DOCK_QUERY) === "narrow" && preset === "wide";
  useLayoutEffect(() => {
    const card = cardRef.current;
    const frame = frameRef.current;
    const stage = stageRef.current;
    const berth = pinnedBerthId ? berths.get(pinnedBerthId) : undefined;
    if (!card || !frame || !stage || !berth || !docked) {
      card?.style.removeProperty("left");
      card?.style.removeProperty("top");
      card?.style.removeProperty("max-height");
      return;
    }
    const fr = frame.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const scale = fr.width / vbW;
    const toViewport = ([x, y]: readonly [number, number]) => [fr.left + (x - vb.x0) * scale, fr.top + (y - vb.y0) * scale] as [number, number];
    const target = toViewport(berth.beamTarget);
    // Visible band of the frame; with room for the card, take the open water that covers no hull or label.
    const top = Math.max(CHROME_TOP, fr.top) + 8;
    const bottom = Math.min(window.innerHeight, fr.bottom) - 8;
    const h = Math.min(card.scrollHeight, bottom - top);
    if (h >= Math.min(card.scrollHeight, 220)) {
      const p = placeOnFreeWater({
        area: { left: fr.left + 4, top, right: fr.right - 4, bottom },
        size: { width: card.offsetWidth, height: h },
        anchor: target,
        hulls: geometry.berths.map((b) => b.hit.map(toViewport)),
        labels: [...frame.querySelectorAll("[data-harbor-label]")].map((el) => el.getBoundingClientRect()),
        blocked: [{ left: window.innerWidth - FEEDBACK_CORNER.width, top: window.innerHeight - FEEDBACK_CORNER.height, right: window.innerWidth, bottom: window.innerHeight }],
        distanceWeight: 0.02,
      });
      card.style.left = `${p.x - sr.left}px`;
      card.style.top = `${p.y - sr.top}px`;
      card.style.maxHeight = `${h}px`;
      return;
    }
    const local = boxToFrameRect(bbox(berth.hit), [vb.x0, vb.y0], scale);
    const stone = { left: fr.left + local.left, top: fr.top + local.top, right: fr.left + local.right, bottom: fr.top + local.bottom };
    const p = placeInspectorCard({
      stone,
      frame: fr,
      medal: target,
      card: { width: card.offsetWidth, height: card.scrollHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      chromeTop: CHROME_TOP,
      corner: FEEDBACK_CORNER,
    });
    card.style.left = `${p.x - sr.left}px`;
    card.style.top = `${p.y - sr.top}px`;
    card.style.maxHeight = `${p.maxHeight}px`;
  }, [pinnedBerthId, berths, geometry, docked, vb.x0, vb.y0, vbW]);

  const hotVessel = hotId ? vessels.get(hotId) : undefined;
  const retained = scene.retained || retainedAfterError;
  const label = `Harbor of ${data.chains.length} chains: ${scene.ships.length} ships over $1B, ${scene.craft.length} small craft, ${scene.tail?.memberIds.length ?? 0} pooled on a barge. One container is $1B.`;
  const card = pinnedVessel ? (
    <HarborRecordCard
      vessel={pinnedVessel}
      names={names}
      focusChainId={focusChainId}
      onClose={() => pin(null, "hero")}
      onShowInTable={revealRow}
      docked={docked}
      cardRef={cardRef}
    />
  ) : null;

  return (
    <section ref={rootRef} className={`${styles.tokens} ${styles.hero}`} style={harborTokenStyle} data-retained={retained ? "true" : undefined} aria-labelledby="harbor-title" onKeyDown={onRootKeyDown}>
      <HarborDefs />
      <a className={styles.skip} href="#chains-leaderboard">
        Skip the harbor
      </a>
      <div className={styles.head}>
        <h2 id="harbor-title" className="pharos-label">
          Harbor · chains by observed stablecoin supply
        </h2>
        <span className={styles.stamp} data-retained={retained ? "true" : undefined}>
          {retained ? `Retained · as of ${formatEventTimestamp(scene.updatedAt, true)}` : `as of ${utcStamp(scene.updatedAt)}`}
        </span>
      </div>
      <p id={HARBOR_KEYS_ID} className="sr-only">
        Arrow keys move between berths in rank order, Home and End jump to the ends, Enter pins a berth&apos;s record card, Escape closes it.
      </p>
      <div ref={stageRef} className={styles.stage}>
        {layout === null ? (
          <div className={styles.reserve} style={{ "--harbor-ar": `${vbW / vbH}` } as CSSProperties} />
        ) : (
          <div ref={frameRef} className={styles.frame} style={{ aspectRatio: `${vbW} / ${vbH}` }} onClick={onSceneClick}>
            <HarborSceneSvg
              scene={scene}
              geometry={geometry}
              litId={litId}
              pinnedId={pinnedBerthId}
              focusId={rovingId}
              label={label}
              onBerthEnter={setHotId}
              onBerthLeave={() => setHotId(null)}
              onBerthFocus={(id) => {
                setFocusId(id);
                setHotId(id);
              }}
              onBerthActivate={onBerthActivate}
              onBerthKeyDown={onBerthKeyDown}
            />
            <div className={styles.overlay} aria-hidden="true">
              {geometry.berths.map((berth) => (
                <BerthLabels key={berth.id} berth={berth} vessel={vessels.get(berth.id)} preset={preset} at={at} lit={berth.id === litId} />
              ))}
              {geometry.jettyLabel && scene.craft.length > 0 ? (
                <span className={styles.label} style={at(geometry.jettyLabel)} data-side={preset === "narrow" ? "above" : undefined} data-harbor-label>
                  <b>{scene.craft.length} chains</b>
                  <span className={styles.num}>$100M–$1B each</span>
                </span>
              ) : null}
              {hotVessel ? (
                <div ref={tagRef} className={styles.tag}>
                  {tagText(hotVessel)}
                </div>
              ) : null}
            </div>
          </div>
        )}
        {preset === "wide" ? card : null}
      </div>
      {scene.overAttributionRatio !== null ? (
        <p className={styles.caption}>Chain rows exceed global supply by {(scene.overAttributionRatio * 100).toFixed(2)}%; no unattributed barge is drawn.</p>
      ) : null}
      <HarborLegend tiered={scene.tiered} />
      {preset === "narrow" && card
        ? createPortal(
            <div className={styles.tokens} style={harborTokenStyle}>
              <div className={styles.sheet} role="dialog" aria-modal="false" aria-label="Chain record">
                {card}
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

function BerthLabels({
  berth,
  vessel,
  preset,
  at,
  lit,
}: {
  berth: HarborBerthGeometry;
  vessel: HarborVessel | undefined;
  preset: "wide" | "narrow";
  at: (pt: readonly [number, number]) => CSSProperties;
  lit: boolean;
}): ReactElement | null {
  if (!vessel || vessel.kind === "craft") return null;
  const side = preset === "narrow" ? "above" : undefined;
  if (!isHarborChainVessel(vessel)) {
    return (
      <span className={styles.label} style={at(berth.label)} data-side={side} data-lit={lit ? "true" : undefined} data-harbor-label>
        <b>{vessel.kind === "tail" ? `+${vessel.memberIds.length} more chains` : "Unattributed"}</b>
        <span className={styles.num}>{formatCompactUsd(vessel.totalUsd)}</span>
      </span>
    );
  }
  const wake = vessel.wake;
  return (
    <>
      <span className={styles.label} style={at(berth.label)} data-side={side} data-lit={lit ? "true" : undefined} data-harbor-label>
        <b>{vessel.chain.name}</b>
        {vessel.partialRows > 0 ? <span className={styles.num}>partial</span> : null}
        <span className={styles.num}>{formatCompactUsd(vessel.totalUsd)}</span>
      </span>
      {/* the exact % is labelled only past the break; below it the wake length reads linearly (tag, card, table carry it) */}
      {wake.kind === "wake" && wake.broken && berth.wakeEnd ? (
        <span className={styles.wakeLabel} style={at(berth.wakeEnd)} data-dir={wake.direction}>
          {wake.direction === "up" ? "▲" : "▼"} {formatSignedPercent(wake.pct, 1)}
        </span>
      ) : null}
    </>
  );
}
