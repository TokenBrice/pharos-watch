/**
 * Harbor 2.0 scene: the drawn harbor as SVG from {@link HarborGeometry}. No hooks: the island (`HarborHero`) owns
 * selection, focus and pointer state and passes it in, so a fixture renders server-side for golden markup.
 *
 * Each berth is one `<a role="button">` (the accessible name carries the entity and its values); everything drawn
 * inside it is `aria-hidden`. Paint order: ground, berths north → south (ring, hull and cargo, flag, wake), lighthouse,
 * beam.
 */
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, ReactElement, Ref } from "react";
import { SceneMarks } from "@/components/scene/scene-marks";
import { SCENE_KIT_GRADIENTS, SceneDefs } from "@/components/scene/scene-defs";
import kit from "@/components/scene/scene-tokens.module.css";
import { CHAIN_HEALTH_HEX, CHAIN_HEALTH_UNRATED_HEX } from "@shared/lib/classification";
import { HARBOR_CARGO_HEX, type HarborScene, type HarborVessel } from "@shared/lib/harbor-scene";
import type { HarborBerthGeometry, HarborGeometry } from "@shared/lib/harbor-scene-geometry";
import { formatPoints, type ScenePoint } from "@shared/lib/scene/projection";
import styles from "./harbor.module.css";

const classCache = new Map<string, string>();
/** Mark class tokens → harbor classes, then kit classes; band flags also take the shared `.flag` fill rule. */
export function harborClassOf(tokens: string): string {
  const cached = classCache.get(tokens);
  if (cached !== undefined) return cached;
  const out = tokens
    .split(" ")
    .flatMap((token) => {
      const cls = styles[token] ?? kit[token] ?? token;
      return /^flag-(robust|healthy|mixed|fragile|concentrated)$/.test(token) ? [cls, styles.flag] : [cls];
    })
    .join(" ");
  classCache.set(tokens, out);
  return out;
}

/** Data hues as custom properties from the shared authorities (health bands, cargo). */
export const harborTokenStyle = {
  "--band-robust": CHAIN_HEALTH_HEX.robust,
  "--band-healthy": CHAIN_HEALTH_HEX.healthy,
  "--band-mixed": CHAIN_HEALTH_HEX.mixed,
  "--band-fragile": CHAIN_HEALTH_HEX.fragile,
  "--band-concentrated": CHAIN_HEALTH_HEX.concentrated,
  "--band-unrated": CHAIN_HEALTH_UNRATED_HEX,
  "--cargo-usdt": HARBOR_CARGO_HEX.usdt,
  "--cargo-usdc": HARBOR_CARGO_HEX.usdc,
  "--cargo-other": HARBOR_CARGO_HEX.other,
  "--cargo-pool": HARBOR_CARGO_HEX.pool,
} as CSSProperties;

export const HARBOR_KEYS_ID = "harbor-keys";

/** Beam wedge from the lantern to a target, `spread` SVG units wide at the far end. */
function beamPoints(from: ScenePoint, to: ScenePoint, spread: number): ScenePoint[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * spread;
  const ny = (dx / len) * spread;
  return [from, [to[0] + nx, to[1] + ny], [to[0] - nx, to[1] - ny]];
}

export interface HarborSceneSvgProps {
  scene: HarborScene;
  geometry: HarborGeometry;
  /** Berth lit by hover, focus, a table row or the pin (ring + beam). */
  litId: string | null;
  pinnedId: string | null;
  /** The roving tab stop. */
  focusId: string | null;
  label: string;
  svgRef?: Ref<SVGSVGElement>;
  onBerthEnter?: (id: string) => void;
  onBerthLeave?: (id: string) => void;
  onBerthFocus?: (id: string, event: FocusEvent) => void;
  onBerthActivate?: (id: string, event: MouseEvent | KeyboardEvent) => void;
  onBerthKeyDown?: (id: string, event: KeyboardEvent) => void;
}

function Berth({
  berth,
  vessel,
  lit,
  pinned,
  focusable,
  props,
}: {
  berth: HarborBerthGeometry;
  vessel: HarborVessel;
  lit: boolean;
  pinned: boolean;
  focusable: boolean;
  props: HarborSceneSvgProps;
}): ReactElement {
  const isChain = vessel.kind === "ship" || vessel.kind === "craft";
  return (
    <a
      id={`berth-${berth.id}`}
      href={isChain ? `#chain-${encodeURIComponent(berth.id)}` : `#${berth.id}`}
      role="button"
      aria-pressed={pinned}
      aria-label={vessel.accessibleName}
      tabIndex={focusable ? 0 : -1}
      className={styles.berth}
      data-berth={berth.id}
      data-lit={lit ? "true" : undefined}
      onMouseEnter={props.onBerthEnter ? () => props.onBerthEnter?.(berth.id) : undefined}
      onMouseLeave={props.onBerthLeave ? () => props.onBerthLeave?.(berth.id) : undefined}
      onFocus={props.onBerthFocus ? (event) => props.onBerthFocus?.(berth.id, event) : undefined}
      onClick={props.onBerthActivate ? (event) => props.onBerthActivate?.(berth.id, event) : undefined}
      onKeyDown={props.onBerthKeyDown ? (event) => props.onBerthKeyDown?.(berth.id, event) : undefined}
    >
      <g aria-hidden="true">
        <polygon className={styles.ring} points={formatPoints(berth.ring)} />
        <SceneMarks marks={berth.marks} classOf={harborClassOf} />
        <SceneMarks marks={berth.flag} classOf={harborClassOf} />
        <SceneMarks marks={berth.wake} classOf={harborClassOf} />
      </g>
      <polygon className={styles.hit} points={formatPoints(berth.hit)} />
    </a>
  );
}

export function HarborSceneSvg(props: HarborSceneSvgProps): ReactElement {
  const { scene, geometry, litId, pinnedId, focusId, label, svgRef } = props;
  const { viewBox: vb } = geometry;
  const vessels = new Map(scene.vessels.map((v) => [v.id, v]));
  const target = litId ? geometry.berths.find((b) => b.id === litId) : undefined;
  return (
    <svg
      ref={svgRef}
      className={styles.scene}
      viewBox={`${vb.x0} ${vb.y0} ${Math.round((vb.x1 - vb.x0) * 10) / 10} ${Math.round((vb.y1 - vb.y0) * 10) / 10}`}
      role="group"
      aria-label={label}
      aria-describedby={HARBOR_KEYS_ID}
    >
      <g aria-hidden="true">
        <SceneMarks marks={geometry.ground} classOf={harborClassOf} />
      </g>
      {geometry.berths.map((berth) => {
        const vessel = vessels.get(berth.id);
        if (!vessel) return null;
        return (
          <Berth
            key={berth.id}
            berth={berth}
            vessel={vessel}
            lit={berth.id === litId}
            pinned={berth.id === pinnedId}
            focusable={berth.id === focusId}
            props={props}
          />
        );
      })}
      <g aria-hidden="true">
        <SceneMarks marks={geometry.lighthouse.marks} classOf={harborClassOf} />
        {target ? <polygon className={styles.beam} points={formatPoints(beamPoints(geometry.lighthouse.lantern, target.beamTarget, 18))} /> : null}
      </g>
    </svg>
  );
}

/** Hatch and kit gradients (`harbor-hatch`, `harbor-g-col` for the lantern deck); render once inside the tokens element. */
export function HarborDefs(): ReactElement {
  return (
    <SceneDefs
      idPrefix="harbor"
      className={kit.defs}
      hatchLineClassName={kit.hatchLine}
      gradients={SCENE_KIT_GRADIENTS}
    />
  );
}
