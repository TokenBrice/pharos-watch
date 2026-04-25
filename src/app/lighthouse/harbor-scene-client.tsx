// src/app/lighthouse/harbor-scene-client.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { HARBOR_PALETTE } from "./systems/palette";
import type { SceneData } from "./systems/scene-data";
import { createInitialFrameState, type DrawableLayer } from "./systems/scene-render";
import { observeReducedMotion } from "./systems/reduced-motion";
import { createTimelineRegistry } from "./systems/timeline-registry";
import { startBeamSweep, startLanternPulse, setBeamSweepDuration } from "./systems/animation";
import { pickLargestHarborPlacement, aimBeamAt } from "./systems/reduced-motion-freeze";
import { buildSkyLayer } from "./layers/sky-layer";
import { buildWaterLayer } from "./layers/water-layer";
import { buildBeamWaterLayer, type BeamWaterLayerAPI } from "./layers/beam-water-layer";
import { buildHorizonLayer } from "./layers/horizon-layer";
import { buildLampLayer, type LampLayerAPI } from "./layers/lamp-layer";
import { buildHarborLayer, type HarborLayerAPI, type HarborPlacement } from "./layers/harbor-layer";
import { buildBoatLayer, type BoatLayerAPI } from "./layers/boat-layer";
import { buildLighthouseLayer, type LighthouseLayerAPI } from "./layers/lighthouse-layer";
import { buildVignetteLayer } from "./layers/vignette-layer";
import { UIOverlay } from "./layers/ui-overlay";
import "./harbor-scene.css";

/**
 * Lighthouse anchor in canvas coordinates. Slightly right-of-center, two-thirds
 * down — leaves vertical room above for the harbour ring (which is anchored
 * NORTH of this point) and below for the foreground vignette.
 */
function getLighthouseAnchor(width: number, height: number): { x: number; y: number } {
  return {
    x: Math.round(width * 0.50),
    y: Math.round(height * 0.78),
  };
}

export function HarborSceneClient({ scene }: { scene: SceneData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef(scene);
  // Keep sceneRef fresh after render commit (React 19's react-hooks/refs disallows ref-set during render body).
  useEffect(() => { sceneRef.current = scene; }, [scene]);

  // Refs to layer APIs (created on mount, reused across scene updates).
  const lampLayerRef = useRef<LampLayerAPI | null>(null);
  const harborLayerRef = useRef<HarborLayerAPI | null>(null);
  const boatLayerRef = useRef<BoatLayerAPI | null>(null);
  const lighthouseLayerRef = useRef<LighthouseLayerAPI | null>(null);
  const beamWaterLayerRef = useRef<BeamWaterLayerAPI | null>(null);
  const beamTweenRef = useRef<gsap.core.Tween | null>(null);
  const placementsRef = useRef<Map<string, HarborPlacement> | null>(null);

  // Public position map for the HTML overlay (re-rendered per state change).
  const [overlayPositions, setOverlayPositions] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d", { alpha: false });
    if (!ctx) return;

    const frame = createInitialFrameState(sceneRef.current);
    frame.dpr = Math.min(window.devicePixelRatio || 1, 2);
    frame.beam.colorHex = sceneRef.current.beam.color;

    const registry = createTimelineRegistry(gsap);
    const beamTween = startBeamSweep(frame.beam, sceneRef.current.beam.sweepSeconds, registry);
    startLanternPulse(frame.lantern, registry);
    beamTweenRef.current = beamTween;

    const sky = buildSkyLayer();
    const water = buildWaterLayer();
    const beamWater = buildBeamWaterLayer();
    const horizon = buildHorizonLayer();
    const lamps = buildLampLayer();
    const harbors = buildHarborLayer();
    const boats = buildBoatLayer();
    const lighthouse = buildLighthouseLayer();
    const vignette = buildVignetteLayer();
    lampLayerRef.current = lamps;
    harborLayerRef.current = harbors;
    boatLayerRef.current = boats;
    lighthouseLayerRef.current = lighthouse;
    beamWaterLayerRef.current = beamWater;

    // Painter's order:
    //   sky -> water (with moonpath) -> beam-on-water highlight ->
    //   alt-peg horizon silhouettes -> harbours -> boats ->
    //   lamps (warm glow above buildings) -> lighthouse (beam over scene) ->
    //   vignette (last; veils edges so the canvas reads as a painting).
    const layers: DrawableLayer[] = [
      sky,
      water,
      beamWater,
      horizon,
      harbors,
      boats,
      lamps,
      lighthouse,
      vignette,
    ];

    let lastWidth = 0;
    let lastHeight = 0;
    const applyAnchorAndPlacements = () => {
      const { x: originX, y: originY } = getLighthouseAnchor(frame.width, frame.height);
      lighthouse.setAnchor(originX, originY);
      beamWater.setLighthouseAnchor(originX, originY);
      const placements = harbors.syncHarbors(sceneRef.current.harbors, originX, originY);
      placementsRef.current = placements;

      // Boats — anchored at each harbour's dock terminus, fanned out left/right
      const seen = new Set<string>();
      for (const harbor of sceneRef.current.harbors) {
        const p = placements.get(harbor.id);
        if (!p) continue;
        // Note: dockEndX/dockEndY are populated only after the harbor layer's
        // first draw call. On initial mount we pass approximate fan positions
        // around p.worldX; a single rAF later we re-place using the real dock
        // end. Either way, boats rendered before re-place are still visible
        // and not misplaced enough to matter on the first frame.
        const baseX = p.dockEndX || p.worldX;
        const baseY = p.dockEndY || (p.worldY + 18);
        harbor.boats.forEach((boat, i) => {
          seen.add(boat.coinId);
          const offset = i * 14 - (harbor.boats.length - 1) * 7;
          boats.upsertBoat(boat, { x: baseX + offset, y: baseY + 4 });
        });
      }
      boats.pruneExcept(seen);

      // Update overlay positions (HTML labels above harbour islands)
      const newPositions = new Map<string, { x: number; y: number }>();
      for (const [id, p] of placements) newPositions.set(id, { x: p.worldX, y: p.worldY });
      setOverlayPositions(newPositions);

      // Beam color/duration tracks PSI band
      frame.beam.colorHex = sceneRef.current.beam.color;
      setBeamSweepDuration(beamTween, sceneRef.current.beam.sweepSeconds);

      // Lamps — gather from placements (positions populate after first paint)
      requestAnimationFrame(() => {
        const allLamps: { x: number; y: number; warm: boolean; phase: number }[] = [];
        for (const p of placements.values()) {
          for (const l of p.lamps) allLamps.push(l);
        }
        lamps.setLamps(allLamps);
      });
    };

    const resize = () => {
      const r = cvs.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      frame.width = w;
      frame.height = h;
      cvs.width = Math.floor(w * frame.dpr);
      cvs.height = Math.floor(h * frame.dpr);
      ctx.imageSmoothingEnabled = false;
      if (w !== lastWidth || h !== lastHeight) {
        lastWidth = w;
        lastHeight = h;
        applyAnchorAndPlacements();
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cvs);

    const disposeRm = observeReducedMotion((m) => {
      frame.reducedMotion = m;
      if (m) {
        registry.pause();
        const placements = placementsRef.current;
        if (placements && lighthouseLayerRef.current) {
          const largest = pickLargestHarborPlacement(sceneRef.current, placements);
          if (largest) {
            const anchor = lighthouseLayerRef.current.anchor();
            aimBeamAt(frame.beam, anchor.x, anchor.y, largest.worldX, largest.worldY);
          }
        }
      } else {
        registry.resume();
      }
    });

    const start = performance.now();
    let rafId = 0;
    const tick = () => {
      frame.t = (performance.now() - start) / 1000;
      frame.scene = sceneRef.current;
      ctx.save();
      ctx.scale(frame.dpr, frame.dpr);
      ctx.fillStyle = HARBOR_PALETTE.deep_sea_2;
      ctx.fillRect(0, 0, frame.width, frame.height);
      const driftX = frame.reducedMotion ? 0 : Math.sin(frame.t * 0.05) * 8;
      const driftY = frame.reducedMotion ? 0 : Math.cos(frame.t * 0.04) * 4;
      ctx.translate(driftX, driftY);
      for (const layer of layers) layer.draw(ctx, frame);
      ctx.restore();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      disposeRm();
      registry.destroy();
      for (const layer of layers) layer.dispose?.();
    };
  }, []);

  // Apply scene changes (data updates) without remounting the canvas
  useEffect(() => {
    if (!harborLayerRef.current || !boatLayerRef.current || !lighthouseLayerRef.current) return;
    // Re-run the harbour/boat/lamp/beam application using the current canvas size.
    // Read width/height from the canvas itself (the inner mount effect's `frame.width`
    // is not in scope here, so we use the live DOM measurements).
    const cvs = canvasRef.current;
    if (!cvs) return;
    const r = cvs.getBoundingClientRect();
    const { x: originX, y: originY } = getLighthouseAnchor(r.width, r.height);
    lighthouseLayerRef.current.setAnchor(originX, originY);
    beamWaterLayerRef.current?.setLighthouseAnchor(originX, originY);
    const placements = harborLayerRef.current.syncHarbors(scene.harbors, originX, originY);
    placementsRef.current = placements;

    const seen = new Set<string>();
    for (const harbor of scene.harbors) {
      const p = placements.get(harbor.id);
      if (!p) continue;
      const baseX = p.dockEndX || p.worldX;
      const baseY = p.dockEndY || (p.worldY + 18);
      harbor.boats.forEach((boat, i) => {
        seen.add(boat.coinId);
        const offset = i * 14 - (harbor.boats.length - 1) * 7;
        boatLayerRef.current!.upsertBoat(boat, { x: baseX + offset, y: baseY + 4 });
      });
    }
    boatLayerRef.current.pruneExcept(seen);

    const newPositions = new Map<string, { x: number; y: number }>();
    for (const [id, p] of placements) newPositions.set(id, { x: p.worldX, y: p.worldY });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOverlayPositions(newPositions);

    if (beamTweenRef.current) {
      setBeamSweepDuration(beamTweenRef.current, scene.beam.sweepSeconds);
    }

    requestAnimationFrame(() => {
      if (!lampLayerRef.current) return;
      const allLamps: { x: number; y: number; warm: boolean; phase: number }[] = [];
      for (const p of placements.values()) {
        for (const l of p.lamps) allLamps.push(l);
      }
      lampLayerRef.current.setLamps(allLamps);
    });
  }, [scene]);

  return (
    <div className="harbor-scene-wrap" data-testid="harbor-scene">
      <canvas ref={canvasRef} className="harbor-scene-canvas" aria-hidden="true" />
      <UIOverlay scene={scene} positions={overlayPositions} />
    </div>
  );
}
