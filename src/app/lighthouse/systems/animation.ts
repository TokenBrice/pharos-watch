import gsap from "gsap";
import type { TimelineRegistry } from "./timeline-registry";

export interface BeamState { rotationRad: number; alpha: number; colorHex: string; }
export interface LanternState { alpha: number; }

/**
 * Continuously rotate `state.rotationRad` 0 -> 2π over `sweepSeconds`,
 * looping forever. The tween is parented to the registry's timeline so a
 * single `registry.pause()` halts the beam too.
 */
export function startBeamSweep(state: BeamState, sweepSeconds: number, registry: TimelineRegistry): gsap.core.Tween {
  state.rotationRad = 0;
  const tween = gsap.to(state, {
    rotationRad: Math.PI * 2,
    duration: sweepSeconds,
    ease: "none",
    repeat: -1,
  });
  registry.parent.add(tween, 0);
  return tween;
}

/**
 * Pulse `state.alpha` 0.85 <-> 0.7 on a 0.42s sine, looping forever.
 * The lantern heartbeat is at a *different* rhythm than the beam sweep —
 * a deliberate decoupling so the lighthouse "breathes" while the beam
 * scans, even when PSI band slows the sweep down to 12s.
 */
export function startLanternPulse(state: LanternState, registry: TimelineRegistry): gsap.core.Tween {
  state.alpha = 0.85;
  const tween = gsap.to(state, {
    alpha: 0.7,
    duration: 0.42,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
  });
  registry.parent.add(tween, 0);
  return tween;
}

/**
 * Adjust the duration of a running tween while preserving its current progress.
 * Used when PSI band changes — the beam doesn't snap, it smoothly shifts speed.
 */
export function setBeamSweepDuration(tween: gsap.core.Tween, seconds: number): void {
  const progress = tween.progress();
  tween.duration(seconds);
  tween.progress(progress);
}
