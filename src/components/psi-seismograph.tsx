"use client";

import { useRef, useEffect } from "react";
import { PSI_HEX_COLORS, type ConditionBand } from "@/lib/psi-colors";

/* ─── Constants ─────────────────────────────────────────────────── */

const CANVAS_W = 800;
const CANVAS_H = 140;
const SPACING = 2; // px between data points
const BUFFER_LEN = Math.ceil(CANVAS_W / SPACING) + 10;
const GRID_STEP = 20; // px between grid lines
const PHASE_SPEED = 0.08;

/* ─── Amplitude from score ──────────────────────────────────────── */

/** Higher PSI score = calmer trace. Returns half-amplitude in px. */
function amplitudeFromScore(score: number): number {
  // score 100 → ~2px (nearly flat), score 0 → ~55px (wild)
  const t = Math.max(0, Math.min(100, score)) / 100;
  return 2 + (1 - t) * 53;
}

/* ─── Component ─────────────────────────────────────────────────── */

interface PsiSeismographProps {
  score: number;
  band: string;
}

export function PsiSeismograph({ score, band }: PsiSeismographProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Mutable refs so animation loop reads latest values without restarting
  const propsRef = useRef({ score, band });
  const animRef = useRef({
    buffer: new Float64Array(BUFFER_LEN).fill(CANVAS_H / 2),
    phase: 0,
    rafId: 0,
  });

  // Sync props into ref
  useEffect(() => {
    propsRef.current = { score, band };
  }, [score, band]);

  // Animation loop
  useEffect(() => {
    // Respect prefers-reduced-motion
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reducedMotion = mq.matches;

    const anim = animRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // DPR scaling for crisp rendering on retina displays
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = CANVAS_W * dpr;
    canvas.height = CANVAS_H * dpr;
    ctx.scale(dpr, dpr);

    if (reducedMotion) {
      // Static render: grid + flat line
      drawGrid(ctx);
      const color = PSI_HEX_COLORS[propsRef.current.band as ConditionBand] ?? "#888";
      const midY = CANVAS_H / 2;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(CANVAS_W, midY);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      return;
    }

    function tick() {
      if (!ctx || !canvas) return;
      const { score: s, band: b } = propsRef.current;
      const amp = amplitudeFromScore(s);
      const midY = CANVAS_H / 2;
      const color = PSI_HEX_COLORS[b as ConditionBand] ?? "#888";

      // Advance phase
      anim.phase += PHASE_SPEED;

      // Compute new Y value
      const sine = Math.sin(anim.phase) * amp;
      const noise1 = Math.sin(anim.phase * 2.7) * amp * 0.3;
      const noise2 = Math.sin(anim.phase * 5.1) * amp * 0.15;
      const jitter = (Math.random() - 0.5) * amp * 0.2;
      const y = midY - (sine + noise1 + noise2 + jitter);

      // Shift buffer left, push new value
      anim.buffer.copyWithin(0, 1);
      anim.buffer[BUFFER_LEN - 1] = y;

      // Clear + draw grid
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      drawGrid(ctx);

      // Draw trace
      ctx.beginPath();
      const startIdx = BUFFER_LEN - Math.ceil(CANVAS_W / SPACING);
      for (let i = startIdx; i < BUFFER_LEN; i++) {
        const x = (i - startIdx) * SPACING;
        if (i === startIdx) {
          ctx.moveTo(x, anim.buffer[i]);
        } else {
          ctx.lineTo(x, anim.buffer[i]);
        }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();

      // Glow dot at leading edge
      const lastX = (BUFFER_LEN - 1 - startIdx) * SPACING;
      const lastY = anim.buffer[BUFFER_LEN - 1];
      ctx.beginPath();
      ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;

      anim.rafId = requestAnimationFrame(tick);
    }

    anim.rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(anim.rafId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_W}
      height={CANVAS_H}
      className="w-full h-auto"
      aria-label="Seismograph trace showing PSI stability"
      role="img"
    />
  );
}

/* ─── Grid helper ───────────────────────────────────────────────── */

function drawGrid(ctx: CanvasRenderingContext2D) {
  const midY = CANVAS_H / 2;

  // Faint grid lines
  ctx.strokeStyle = "rgba(128,128,128,0.08)";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);

  // Vertical
  for (let x = GRID_STEP; x < CANVAS_W; x += GRID_STEP) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CANVAS_H);
    ctx.stroke();
  }

  // Horizontal
  for (let y = GRID_STEP; y < CANVAS_H; y += GRID_STEP) {
    if (Math.abs(y - midY) < 1) continue; // skip center — drawn separately
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(CANVAS_W, y);
    ctx.stroke();
  }

  // Center baseline — dashed, slightly more visible
  ctx.strokeStyle = "rgba(128,128,128,0.15)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(CANVAS_W, midY);
  ctx.stroke();
  ctx.setLineDash([]);
}
