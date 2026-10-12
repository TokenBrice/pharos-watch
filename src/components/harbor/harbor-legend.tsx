/**
 * Harbor legend, drawn by the scene's own geometry (container, bay, flags) so the key and the scene cannot drift.
 */
import type { CSSProperties, ReactElement } from "react";
import { SceneMarks } from "@/components/scene/scene-marks";
import { CHAIN_HEALTH_BAND_ORDER, CHAIN_HEALTH_LABELS, CHAIN_HEALTH_PENNANTS } from "@shared/lib/classification";
import { HARBOR_CARGO_LABELS, MAX_BAYS_PER_TIER, WAKE_BREAK_PCT, WAKE_MIN_PCT, type HarborFlag } from "@shared/lib/harbor-scene";
import { harborFlagMarks, HARBOR_LAYOUTS } from "@shared/lib/harbor-scene-geometry";
import type { SceneMark } from "@shared/lib/scene/marks";
import { bbox, SCENE_DIMETRIC } from "@shared/lib/scene/projection";
import { boxMarks } from "@shared/lib/scene/solids";
import { harborClassOf } from "./harbor-scene";
import styles from "./harbor.module.css";

function MiniMarks({ marks, height }: { marks: SceneMark[]; height: number }): ReactElement {
  const pts = marks.flatMap((m) => (m.kind === "polygon" ? m.points : m.kind === "line" ? [[m.x1, m.y1] as [number, number], [m.x2, m.y2] as [number, number]] : []));
  const b = bbox(pts);
  const w = b.x1 - b.x0 + 2;
  const h = b.y1 - b.y0 + 2;
  return (
    <svg aria-hidden="true" viewBox={`${b.x0 - 1} ${b.y0 - 1} ${w} ${h}`} height={height} width={(height * w) / h}>
      <SceneMarks marks={marks} classOf={harborClassOf} />
    </svg>
  );
}

const L = HARBOR_LAYOUTS.wide;
const containerMarks = (cls: string, i: number, j: number) => boxMarks(SCENE_DIMETRIC, i, j, 0, L.L, L.W, 0.34, cls);
const ONE = containerMarks("cg-other", 0, 0);
const BAY = Array.from({ length: 10 }, (_, k) => containerMarks("cg-other", Math.floor(k / 2) * (L.L + L.gap), (k % 2) * (L.W + L.gap))).flat();
const HATCH = [...boxMarks(SCENE_DIMETRIC, 0, 0, 0, L.L, L.W, 0.34, "cg-unattr"), ...boxMarks(SCENE_DIMETRIC, 0, 0, 0, L.L, L.W, 0.34, "hatch", "")];
const swatch = (name: string): CSSProperties => ({ background: `var(--cargo-${name})` });

export function HarborLegend({ tiered }: { tiered: boolean }): ReactElement {
  return (
    <ul className={styles.legend} aria-label="Harbor legend">
      <li>
        <MiniMarks marks={ONE} height={14} /> 1 container = $1B of observed chain supply
      </li>
      <li>
        <MiniMarks marks={BAY} height={20} /> 1 bay = 10 containers = $10B
      </li>
      {(["usdt", "usdc", "other", "pool"] as const).map((kind) => (
        <li key={kind}>
          <span className={styles.swatch} style={swatch(kind)} /> {HARBOR_CARGO_LABELS[kind]}
        </li>
      ))}
      <li>
        <MiniMarks marks={HATCH} height={14} /> Unattributed, or unobserved rows (partial)
      </li>
      {CHAIN_HEALTH_BAND_ORDER.map((band) => {
        const flag: HarborFlag = { kind: "band", band, label: CHAIN_HEALTH_LABELS[band], pennants: CHAIN_HEALTH_PENNANTS[band], score: null };
        return (
          <li key={band}>
            <MiniMarks marks={harborFlagMarks(SCENE_DIMETRIC, 0, 0, 0, flag)} height={26} /> {CHAIN_HEALTH_LABELS[band]}
          </li>
        );
      })}
      <li>
        <MiniMarks marks={harborFlagMarks(SCENE_DIMETRIC, 0, 0, 0, { kind: "unrated", reason: "" })} height={26} /> Not rated
      </li>
      <li className={styles.wide}>
        7d wake: <span className={styles.wakeKey} data-dir="up">▲ growth</span> / <span className={styles.wakeKey} data-dir="down">▼ decline</span>, length linear to ±{WAKE_BREAK_PCT}% (break mark beyond), none under {WAKE_MIN_PCT}%
      </li>
      {tiered ? <li>Containers beyond ${MAX_BAYS_PER_TIER * 10}B stack a second tier</li> : null}
    </ul>
  );
}
