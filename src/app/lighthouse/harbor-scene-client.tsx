"use client";
import { useEffect, useRef } from "react";
import type { SceneData } from "./systems/scene-data";
import "./harbor-scene.css";

export function HarborSceneClient(_props: { scene: SceneData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = cvs.getBoundingClientRect();
      cvs.width = Math.floor(r.width * dpr);
      cvs.height = Math.floor(r.height * dpr);
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#0a0e1d";
      ctx.fillRect(0, 0, cvs.width, cvs.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cvs);
    return () => ro.disconnect();
  }, []);
  return <canvas ref={ref} className="harbor-scene-canvas" aria-hidden="true" />;
}
