"use client";

import { useId, useMemo, type CSSProperties, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import {
  PSI_BEACON_COMPONENT_LABELS,
  buildPsiBeaconModel,
  type PsiBeaconModel,
  type PsiBeaconPenaltyKey,
  type PsiBeaconState,
} from "@shared/lib/psi-beacon";
import { layoutPsiBeacon, psiBeaconViewBox, type PsiBeaconLabel, type PsiBeaconLayout } from "@shared/lib/psi-beacon-geometry";
import { BeaconTower, BEACON_PROJECTION } from "./beacon-tower";
import { SceneKitDefs } from "@/components/scene/scene-defs";
import kit from "@/components/scene/scene-tokens.module.css";
import styles from "./psi-beacon.module.css";

const VIEW_BOX = psiBeaconViewBox(BEACON_PROJECTION);

function Label({ label, className }: { label: PsiBeaconLabel; className: string }): ReactElement {
  return (
    <text className={className} x={label.x} y={label.y}>
      {label.text}
    </text>
  );
}

function signed(value: number, digits: number): string {
  // Sign follows the printed value, so a tiny drag never reads "−0.0".
  if (Number(value.toFixed(digits)) === 0) return (0).toFixed(digits);
  if (value > 0) return `+${value.toFixed(digits)}`;
  if (value < 0) return `−${Math.abs(value).toFixed(digits)}`;
  return value.toFixed(digits);
}

function patternIds(uid: string): Record<PsiBeaconPenaltyKey | "drag" | "beam" | "halo" | "sheet", string> {
  const base = `psi-beacon-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return {
    severity: `${base}-sev`,
    breadth: `${base}-br`,
    stressBreadth: `${base}-sb`,
    drag: `${base}-drag`,
    beam: `${base}-beam`,
    halo: `${base}-halo`,
    sheet: `${base}-sheet`,
  };
}

/**
 * Paint servers. The beam gradient runs along the fixed 0 → 100 ruler vector (user space), so the light at a given
 * distance is the same whatever the score: brightness never encodes the value, only where the cone is cut.
 */
function Patterns({ ids, axis, sheetAxis }: { ids: ReturnType<typeof patternIds>; axis: PsiBeaconLayout["axis"]; sheetAxis: PsiBeaconLayout["axis"] | null }): ReactElement {
  return (
    <defs>
      {sheetAxis ? (
        <linearGradient id={ids.sheet} gradientUnits="userSpaceOnUse" x1={sheetAxis.x1} y1={sheetAxis.y1} x2={sheetAxis.x2} y2={sheetAxis.y2}>
          <stop offset="0" className={styles.sheetStop0} />
          <stop offset="1" className={styles.sheetStop1} />
        </linearGradient>
      ) : null}
      <linearGradient id={ids.beam} gradientUnits="userSpaceOnUse" x1={axis.x1} y1={axis.y1} x2={axis.x2} y2={axis.y2}>
        <stop offset="0" className={styles.beamStop0} />
        <stop offset="1" className={styles.beamStop1} />
      </linearGradient>
      <linearGradient id={ids.halo} gradientUnits="userSpaceOnUse" x1={axis.x1} y1={axis.y1} x2={axis.x2} y2={axis.y2}>
        <stop offset="0" className={styles.haloStop0} />
        <stop offset="1" className={styles.haloStop1} />
      </linearGradient>
      <pattern id={ids.severity} width={3} height={3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect className={styles.hatchBg} width={3} height={3} />
        <line className={styles.hatch} x1={0} y1={0} x2={0} y2={3} />
      </pattern>
      <pattern id={ids.breadth} width={2.5} height={2.5} patternUnits="userSpaceOnUse">
        <rect className={styles.hatchBg} width={2.5} height={2.5} />
        <line className={styles.hatch} x1={0} y1={0} x2={0} y2={2.5} />
      </pattern>
      <pattern id={ids.stressBreadth} width={3} height={3} patternUnits="userSpaceOnUse">
        <rect className={styles.hatchBg} width={3} height={3} />
        <circle className={styles.hatch} cx={1.5} cy={1.5} r={0.5} />
      </pattern>
      <pattern id={ids.drag} width={3} height={3} patternUnits="userSpaceOnUse">
        <line className={styles.dragHatch} x1={0} y1={1.5} x2={3} y2={1.5} />
      </pattern>
    </defs>
  );
}

function plateLines(model: PsiBeaconModel, state: PsiBeaconState): [string, string | null] {
  if (state.kind === "loading") return ["Loading", null];
  if (state.kind === "unavailable") return ["No current reading", null];
  const value = model.plate ? `${model.plate.score.toFixed(1)} ${model.plate.band}` : null;
  if (state.kind === "retained") return [`Retained${state.asOfLabel ? ` · as of ${state.asOfLabel}` : ""}`, value];
  return ["Instant sample", value];
}

function Swatch({ fill, className, dashed = false }: { fill?: string; className?: string; dashed?: boolean }): ReactElement {
  return (
    <svg className={styles.swatch} width={14} height={8} aria-hidden="true">
      <rect
        x={0.5}
        y={0.5}
        width={13}
        height={7}
        className={className}
        fill={fill}
        strokeDasharray={dashed ? "1.5 2" : undefined}
      />
    </svg>
  );
}

function Legend({ model, state, ids }: { model: PsiBeaconModel; state: PsiBeaconState; ids: ReturnType<typeof patternIds> }) {
  if (state.kind === "loading") return null;
  if (state.kind === "unavailable") {
    return (
      <ul className={styles.legend} data-testid="psi-beacon-legend">
        <li>PSI unavailable · {state.reason}</li>
      </ul>
    );
  }
  const { reading } = state;
  const missing = new Set(reading.unavailableComponents);
  const penalty = (key: PsiBeaconPenaltyKey) => {
    const value = reading.components[key];
    const bank = model.fog.find((entry) => entry.key === key);
    return (
      <li key={key}>
        <Swatch className={styles.fog} fill={`url(#${ids[key]})`} />
        <span>{PSI_BEACON_COMPONENT_LABELS[key]}</span>
        <span className={styles.legendValue}>
          {value === null || missing.has(key) ? "n/a" : value.toFixed(1)}
          {bank?.lowerBound ? " (≥)" : ""}
        </span>
      </li>
    );
  };
  const trend = reading.components.trend;
  return (
    <ul className={styles.legend} data-testid="psi-beacon-legend">
      <li>
        <Swatch className={styles.beamSwatch} />
        <span>instant</span>
        <span className={styles.legendValue}>{reading.score.toFixed(1)}</span>
      </li>
      {model.unknown?.unreconciled ? (
        <li>
          <Swatch className={styles.unknown} dashed />
          <span>components do not reconcile with the score</span>
        </li>
      ) : (
        <>
          {(["severity", "breadth", "stressBreadth"] as const).map(penalty)}
          <li>
            {trend !== null && trend < 0 ? <Swatch className={styles.drag} fill={`url(#${ids.drag})`} /> : <Swatch className={styles.gain} />}
            <span>trend</span>
            <span className={styles.legendValue}>{trend === null ? "n/a" : signed(trend, 1)}</span>
          </li>
          {model.unknown ? (
            <li>
              <Swatch className={styles.unknown} dashed />
              <span>unavailable, not zero</span>
            </li>
          ) : null}
        </>
      )}
      {model.avgTick ? (
        <li>
          <svg className={styles.swatch} width={6} height={10} aria-hidden="true">
            <line className={styles.tick} x1={3} y1={0} x2={3} y2={10} />
          </svg>
          <span>24h avg</span>
          <span className={styles.legendValue}>{model.avgTick.value.toFixed(1)}</span>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The PSI lighthouse as a reading instrument: lit length is the instant score on a
 * 0–100 ruler, the dark remainder is split into one fog bank per penalty, range rings
 * mark the band thresholds and a tick marks the 24h average. Retained data loses its
 * hue; unavailable data draws no beam at all (never a calm or zero-length one).
 */
export function PsiBeacon({ state, className }: { state: PsiBeaconState; className?: string }) {
  const uid = useId();
  const ids = useMemo(() => patternIds(uid), [uid]);
  const model = useMemo(() => buildPsiBeaconModel(state), [state]);
  const layout = useMemo(() => layoutPsiBeacon(model, BEACON_PROJECTION), [model]);
  const [kicker, value] = plateLines(model, state);
  const beamHex = model.paint.mode === "dark" ? undefined : model.paint.hex;
  const plateX = layout.lantern[0] + 26;
  const plateY = layout.lantern[1] - 14;

  return (
    <figure
      className={cn(kit.tokens, styles.tokens, styles.root, className)}
      data-testid="psi-beacon"
      data-state={model.state}
      data-paint={model.paint.mode}
      style={beamHex ? ({ "--beam": beamHex } as CSSProperties) : undefined}
    >
      <SceneKitDefs />
      <svg
        className={cn(kit.scene, styles.svg)}
        viewBox={`${VIEW_BOX.x} ${VIEW_BOX.y} ${VIEW_BOX.width} ${VIEW_BOX.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={model.ariaLabel}
        aria-busy={state.kind === "loading" ? true : undefined}
      >
        <Patterns ids={ids} axis={layout.axis} sheetAxis={layout.beam?.sheetAxis ?? null} />
        {/* The sea fills the whole frame (beyond the letterboxed viewBox): the scene's chart surface. */}
        <rect className={kit.sea} x={VIEW_BOX.x - 2000} y={VIEW_BOX.y - 2000} width={VIEW_BOX.width + 4000} height={VIEW_BOX.height + 4000} />
        {layout.rings.map((ring) => (
          <g key={ring.value}>
            <path className={styles.ring} d={ring.d} />
            <Label label={ring.label} className={styles.ringLabel} />
          </g>
        ))}
        {layout.zones.map((zone) => (
          <Label key={zone.band} label={zone.label} className={styles.zoneLabel} />
        ))}
        <line className={styles.axis} {...layout.axis} />
        {layout.beam ? (
          <>
            <polygon className={styles.halo} points={layout.beam.halo} fill={`url(#${ids.halo})`} />
            <polygon className={styles.beam} points={layout.beam.points} fill={`url(#${ids.beam})`} data-testid="psi-beacon-beam" />
          </>
        ) : null}
        {layout.fog.map((bank) => (
          <polygon key={bank.key} className={styles.fog} points={bank.points} fill={`url(#${ids[bank.key]})`} data-testid={`psi-beacon-fog-${bank.key}`}>
            <title>{bank.title}</title>
          </polygon>
        ))}
        {layout.drag ? (
          <polygon className={styles.drag} points={layout.drag} fill={`url(#${ids.drag})`} data-testid="psi-beacon-drag">
            <title>Trend drag: {model.drag ? signed(model.drag.value, 2) : ""} points</title>
          </polygon>
        ) : null}
        {layout.gain ? (
          <polygon className={styles.gain} points={layout.gain} data-testid="psi-beacon-gain">
            <title>Trend gain: {model.gain ? signed(model.gain.value, 2) : ""} points</title>
          </polygon>
        ) : null}
        {layout.unknown ? (
          <g data-testid="psi-beacon-unknown">
            <polygon className={styles.unknown} points={layout.unknown.points} />
            <Label label={layout.unknown.label} className={styles.unknownLabel} />
          </g>
        ) : null}
        {layout.beam ? <line className={cn(styles.tip, model.beam?.dashedTip && styles.tipDashed)} {...layout.beam.tip} /> : null}
        {layout.fog.map((bank) => (bank.lowerBound ? <Label key={`lb-${bank.key}`} label={bank.lowerBound} className={styles.tickLabel} /> : null))}
        {layout.avgTick ? (
          <g data-testid="psi-beacon-avg-tick">
            <line className={styles.tick} {...layout.avgTick.line} />
            <Label label={layout.avgTick.label} className={styles.tickLabel} />
          </g>
        ) : null}
        {layout.clampTick ? (
          <g data-testid="psi-beacon-clamp">
            <line className={styles.tick} {...layout.clampTick.line} />
            <Label label={layout.clampTick.label} className={styles.tickLabel} />
          </g>
        ) : null}
        {layout.zeroLabel ? <Label label={layout.zeroLabel} className={styles.tickLabel} /> : null}
        {/* The lamp's light falls from the lantern onto the ruler; the tower, painted after it, hides what is behind. */}
        {layout.beam ? <polygon className={styles.sheet} points={layout.beam.sheet} fill={`url(#${ids.sheet})`} data-testid="psi-beacon-sheet" /> : null}
        <BeaconTower />
        {model.paint.mode === "lit" ? (
          <>
            <circle className={styles.lampHalo} cx={layout.lantern[0]} cy={layout.lantern[1]} r={11} />
            <circle className={styles.lamp} cx={layout.lantern[0]} cy={layout.lantern[1]} r={4.2} data-testid="psi-beacon-lamp" />
          </>
        ) : (
          <circle className={styles.lampDark} cx={layout.lantern[0]} cy={layout.lantern[1]} r={4.2} />
        )}
        <text className={styles.plateKicker} x={plateX} y={plateY}>{kicker}</text>
        {value ? <text className={styles.plateValue} x={plateX} y={plateY + 16}>{value}</text> : null}
      </svg>
      <Legend model={model} state={state} ids={ids} />
    </figure>
  );
}
